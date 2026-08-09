// WHOP PRODUCT CATALOG — the minimum surface the Shopify↔Whop mapper needs:
// list the company's products, and mint one when no same-named product exists.
//
// CREDENTIALS: resolved per funnel through the EXISTING mechanism
// (services/gatewayConfigs.js — encrypted at rest, per-funnel live/sandbox
// sets, WHOP_API_KEY / WHOP_COMPANY_ID as the platform-wide env fallback).
// Nothing here reads a raw env credential of its own, and nothing here is
// module-cached: a key rotation takes effect on the next call, no redeploy.
// The key travels in the Authorization HEADER only — never in a URL, never in
// argv, never in an error message.
//
// FAILURE SEMANTICS (mirrors routes/shopifyVariants.js — an outage must never
// read as "the company has no products", which would make the mapper offer to
// CREATE duplicates of products that already exist):
//   no api_key / company_id     -> WhopUnavailableError 'whop_not_configured'
//   401 / 403                   -> 'whop_auth_error'      (dead key, not retryable)
//   transport / timeout / 5xx   -> 'whop_unavailable'     (retryable)
//   unparseable body            -> 'whop_unavailable'
//
// ENDPOINT SHAPE — DECISION MADE / SPEC AMBIGUITY: the reference tool never
// called a real Whop product API (its "create" wrote a local placeholder row,
// see funnel-os backend/app/routers/checkout.py create_whop_product_mapping),
// so there is no verified-against-live contract to copy. The paths below are
// the documented Whop company-products routes and are BOTH env-overridable
// (WHOP_API_BASE / WHOP_PRODUCTS_PATH) so the operator can retarget them
// without a code change. They are verified in this repo against a mock only —
// see server/tests/funnel-settings/commerce.mjs.
//
// PRICE: Whop's product object carries no price — pricing lives on PLANS. The
// Shopify display price is therefore stored on OUR mapping row and is not sent
// to Whop. It is display data either way; the checkout re-prices server-side.

export const WHOP_TIMEOUT_MS = 8_000;
export const WHOP_PAGE_SIZE = 50;
export const WHOP_MAX_PAGES = 10; // hard stop: 500 products

export class WhopUnavailableError extends Error {
  constructor(reason, code = 'whop_unavailable') {
    super(reason);
    this.name = 'WhopUnavailableError';
    this.code = code;
    this.status = 503;
  }
}

// Read at CALL time, never module-cached (same posture as gatewayStatus.js).
export function whopBase(mode = 'live') {
  if (process.env.WHOP_API_BASE) return process.env.WHOP_API_BASE;
  return mode === 'sandbox'
    ? 'https://sandbox-api.whop.com/api/v1'
    : 'https://api.whop.com/api/v1';
}

function productsPath() {
  return process.env.WHOP_PRODUCTS_PATH || '/products';
}

/**
 * Pure. The RAW list a Whop page carries, before any filtering. Whop list
 * payloads have appeared as {data:[…]}, {products:[…]} and a bare array across
 * API generations — read all three. Total: never throws.
 *
 * This exists SEPARATELY from extractWhopProducts because paging must be
 * decided on how many rows the SHOP SENT, not on how many survived our
 * filtering — see listWhopProducts.
 */
export function rawWhopList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.products)) return payload.products;
  return [];
}

/**
 * Pure. The raw list, minus anything without a usable id (an unaddressable
 * product cannot be a mapping target). Total: never throws, never returns null.
 */
export function extractWhopProducts(payload) {
  const raw = rawWhopList(payload);
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const id = p.id ?? p.product_id ?? p.uuid;
    if (id == null || String(id).trim() === '') continue;
    out.push({
      id: String(id),
      name: String(p.name ?? p.title ?? ''),
    });
  }
  return out;
}

/**
 * Pure. The SINGLE-product form of the above, for a create response. Whop has
 * answered creates as the bare object, as {data:{…}} and as {data:[{…}]} — all
 * three unwrap here. Returns null when no addressable id is present.
 */
export function extractWhopProduct(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = extractWhopProducts([payload]);
  if (direct.length) return direct[0];
  const inner = Array.isArray(payload) ? payload : payload.data ?? payload.product;
  const list = extractWhopProducts(Array.isArray(inner) ? inner : [inner]);
  return list.length ? list[0] : null;
}

/**
 * Pure. The MATCH RULE, stated in one place: a Shopify product maps to the
 * Whop product whose name is the same after trimming and case-folding.
 * "Exact name" in the spec cannot mean byte-exact — Whop names round-trip
 * through forms that trim, and an operator reading two identical-looking names
 * would be told there is no match. Anything looser (substring, fuzzy) would
 * silently link the WRONG product, so this is as loose as it goes.
 * Returns the first match in list order, or null.
 */
export function findWhopByName(name, whopProducts) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (!key) return null;
  for (const w of Array.isArray(whopProducts) ? whopProducts : []) {
    if (!w || typeof w !== 'object') continue;
    if (String(w.name == null ? '' : w.name).trim().toLowerCase() === key) return w;
  }
  return null;
}

/**
 * Pure planner — the whole mapping DECISION, with no I/O, so it is testable
 * without a Whop at all. Given the synced Shopify products, the mappings that
 * already exist and the Whop catalog, decide per product: skip / match / create.
 *   already  products whose mapping row is already `mapped`
 *   match    [{ product, whop }]  an existing Whop product with the same name
 *   create   [product]            nothing matched -> mint one
 * Products with a blank title are SKIPPED (an unnamed product cannot be matched
 * or sensibly created) and reported in `skipped`.
 */
export function planWhopMapping(products, existingMappings, whopProducts) {
  const mappedIds = new Set(
    (Array.isArray(existingMappings) ? existingMappings : [])
      .filter((m) => m && m.status === 'mapped' && String(m.whop_product_id || '') !== '')
      .map((m) => String(m.shopify_product_id))
  );
  const plan = { already: [], match: [], create: [], skipped: [] };
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || typeof p !== 'object') continue;
    const pid = String(p.shopify_product_id ?? p.id ?? '');
    if (!pid) continue;
    if (mappedIds.has(pid)) { plan.already.push(p); continue; }
    const title = String(p.title == null ? '' : p.title).trim();
    if (!title) { plan.skipped.push(p); continue; }
    const whop = findWhopByName(title, whopProducts);
    if (whop) plan.match.push({ product: p, whop });
    else plan.create.push(p);
  }
  return plan;
}

async function whopFetch(url, { apiKey, method = 'GET', body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHOP_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError (our 8s budget) and DNS/socket failures are one class to the
    // caller: retryable. err.message never carries the key.
    throw new WhopUnavailableError(`fetch_failed ${err.name}`);
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new WhopUnavailableError(`http_${resp.status}`, 'whop_auth_error');
  }
  if (!resp.ok) throw new WhopUnavailableError(`http_${resp.status}`);
  try {
    return await resp.json();
  } catch {
    throw new WhopUnavailableError('bad_json');
  }
}

function requireCreds(creds) {
  const apiKey = creds?.api_key || '';
  const companyId = creds?.company_id || '';
  if (!apiKey || !companyId) {
    throw new WhopUnavailableError('not configured', 'whop_not_configured');
  }
  return { apiKey, companyId };
}

/**
 * Every product on the company, paged. An outage THROWS — it must never
 * degrade to [] (that would make the mapper create duplicates).
 *
 * Returns { products, complete, dropped }:
 *   complete  the walk provably reached the last page. FALSE means the caller
 *             is holding a PREFIX of the catalog and must not conclude that a
 *             name is absent from it.
 *   dropped   rows the shop sent that carried no addressable id.
 *
 * PAGING IS DECIDED ON THE RAW PAGE LENGTH. Deciding it on the FILTERED length
 * was a live-duplicate bug: one id-less row in a full 50-row page made the
 * batch 49, "49 < 50" read as "last page", the walk stopped early, and a
 * product sitting on page 2 looked absent — so the mapper CREATED a second
 * live Whop product for something that already existed.
 */
export async function listWhopProducts(creds, { mode = 'live' } = {}) {
  const { apiKey, companyId } = requireCreds(creds);
  const base = whopBase(mode).replace(/\/+$/, '');
  const products = [];
  let dropped = 0;
  for (let page = 1; page <= WHOP_MAX_PAGES; page += 1) {
    const url = `${base}${productsPath()}?company_id=${encodeURIComponent(companyId)}`
      + `&per=${WHOP_PAGE_SIZE}&page=${page}`;
    const payload = await whopFetch(url, { apiKey });
    const raw = rawWhopList(payload);
    const batch = extractWhopProducts(payload);
    dropped += raw.length - batch.length;
    products.push(...batch);
    if (raw.length < WHOP_PAGE_SIZE) return { products, complete: true, dropped };
  }
  // Ran out of pages with a full page in hand: there is very likely more.
  return { products, complete: false, dropped };
}

/**
 * Mint a Whop product named exactly like the Shopify one. Returns the created
 * product in the same {id,name} shape; throws WhopUnavailableError on any
 * failure, and throws 'whop_unavailable' if Whop answers 2xx with no usable id
 * (a create we cannot address is not a success we may record).
 */
export async function createWhopProduct(creds, { name, mode = 'live' } = {}) {
  const { apiKey, companyId } = requireCreds(creds);
  const clean = String(name == null ? '' : name).trim().slice(0, 200);
  if (!clean) throw new WhopUnavailableError('empty_name', 'whop_invalid_name');
  const base = whopBase(mode).replace(/\/+$/, '');
  const payload = await whopFetch(`${base}${productsPath()}`, {
    apiKey,
    method: 'POST',
    // No price: Whop pricing lives on plans, not products (see header).
    body: { name: clean, company_id: companyId, visibility: 'hidden' },
  });
  const created = extractWhopProduct(payload);
  // PER-ROW, not fatal. A 2xx whose body carries no addressable id is an
  // anomaly about THIS product (a validation quirk, a name Whop rejected) —
  // the next product may well succeed. Giving it the generic
  // 'whop_unavailable' code made the caller treat it as a shop-wide outage and
  // abandon every remaining product in the batch.
  if (!created) throw new WhopUnavailableError('create_returned_no_id', 'whop_create_no_id');
  // Whop may normalise the name; keep OURS as the fallback so the mapping row
  // is never nameless.
  return { id: created.id, name: created.name || clean };
}

export default {
  listWhopProducts,
  createWhopProduct,
  rawWhopList,
  extractWhopProducts,
  extractWhopProduct,
  findWhopByName,
  planWhopMapping,
  WhopUnavailableError,
};
