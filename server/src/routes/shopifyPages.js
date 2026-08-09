// CLONE FROM SHOPIFY — list the store's Online Store pages, then import one
// into the EXISTING clone-a-page pipeline.
// Mounted at /api/v1/shopify-pages (authenticate + funnels:access).
//
// WHAT THIS IS NOT: it is not a second scanner. `/import` fetches a page's
// `body_html` from the Shopify Admin API and hands it to scanHtml() imported
// from routes/pageClone.js — the same clean/rewrite/split path the paste and
// upload tabs use, under the same 10MB input and 2MB cleaned-output caps.
// The client then reuses the same section picker and the same
// POST /page-clone/create. Nothing here writes anything, anywhere.
//
// TRANSPORT: Shopify Admin REST (`pages.json`). The Admin GraphQL `pages`
// connection only exists on recent API versions, while `pages.json` has been
// stable on every version this codebase can be pointed at (SHOPIFY_API_VERSION
// defaults to 2024-01). A transport we cannot verify against the live store is
// not a transport — so there is one path, not a GraphQL-with-REST-fallback
// pair whose fallback leg would never be exercised.
//
// CREDENTIALS: read from env at CALL time, never module-cached (same posture
// as shopifyVariants.js / checkoutPricing.js, so a rotation needs no
// redeploy). The token travels in the X-Shopify-Access-Token HEADER only —
// never in a URL, an argv, or an error message.
//
// FAILURE SEMANTICS — three buckets that must never be conflated. A Shopify
// outage must read as an outage, NEVER as "this store has no pages" (an empty
// `pages: []` is a POSITIVE claim about the store), and a PERMANENT failure
// must never read as a retryable one (a Retry button against a deleted page
// or a revoked token just burns the operator's time):
//   RETRYABLE  5xx / 429 / transport / timeout -> 503 shopify_unavailable
//   PERMANENT  401,403 -> shopify_auth_error · 402 -> shopify_store_frozen
//              423 -> shopify_store_locked · other 4xx -> shopify_rejected
//              404 on a page fetch -> 404 page_not_found
//   CONFIG     no/!malformed store, token or api version -> shopify_not_configured
// Everything permanent carries retryable:false so the UI hides Retry.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ESCAPE_HATCH_MAX, INPUT_MAX, scanHtml } from './pageClone.js';
import { ShopifyUnavailableError } from './shopifyVariants.js';

const router = Router();

// This route shares the Shopify Admin call budget with LIVE CHECKOUT PRICING
// and the builder's variant typeahead. It gets its OWN limiter key so a
// hammered page picker cannot consume the typeahead's allowance (and vice
// versa), but the cap is deliberately modest for the same reason.
export const PAGES_RATE_MAX = 30;
export const PAGES_RATE_WINDOW_SEC = 60;

export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 250; // Shopify's own per-request ceiling
export const LIST_HOP_MAX = 4; // cursor hops before we stop and say so
export const LIST_NODE_MAX = 500; // hard ceiling on rows returned
export const FETCH_TIMEOUT_MS = 8_000;

// B1 — THE LIST RUNS IN THE SAME PROCESS AS PUBLIC CHECKOUT AND /f.
// Deriving a summary and a theme-built flag from FULL body_html is O(total
// catalog bytes) of synchronous string work on the event loop: measured at
// 500 rows x ~292KB it blocked for 1,945 ms and added 183 MB of heap, which
// is a checkout outage caused by a page picker. Only the head of each body is
// ever needed — a 160-char summary and a 200-char visible-text floor — so
// every row is sliced to BODY_PROBE_BYTES first and the text is extracted
// ONCE and reused for both. LIST_NODE_MAX x BODY_PROBE_BYTES is bounded by
// LIST_BODY_BUDGET_BYTES (asserted in the harness), and a runtime accumulator
// backstops it if either constant is ever raised without the other.
export const BODY_PROBE_BYTES = 16 * 1024;
export const LIST_BODY_BUDGET_BYTES = 8 * 1024 * 1024;

// A page whose body_html carries less visible text than this has almost no
// content in Shopify's page editor. It is a BADGE on the list, not a gate:
// the observation is worth surfacing, but it is not our place to refuse the
// import over it (a 199-character page is still a page).
export const THEME_BUILT_MIN_TEXT = 200;

export const SUMMARY_MAX = 160;

// How long a resolved storefront domain is reused. Without this, /shop.json
// was re-fetched on EVERY list and EVERY import — 2 Admin calls per request
// against the bucket shared with live checkout pricing.
export const STOREFRONT_TTL_MS = 5 * 60 * 1000;
// A failed lookup is cached far more briefly, but it IS cached: otherwise a
// broken /shop.json restores the per-request fan-out it exists to prevent.
export const STOREFRONT_FAIL_TTL_MS = 60 * 1000;

// A hostname, nothing more. A store value carrying a path or credentials
// would smuggle itself into the request URL, so it is refused as "not
// configured" rather than half-trusted.
const STORE_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
// n1 — the API version is interpolated into the request PATH. Anchored to
// Shopify's own YYYY-MM shape so a stray slash cannot walk the Admin API.
const API_VERSION_RE = /^\d{4}-\d{2}$/;

const REST_FIELDS = 'id,title,handle,updated_at,published_at,body_html';

function shopifyCreds() {
  return {
    store: process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

// code -> { httpStatus, retryable, message }. `shopify_unavailable` is the
// ONLY retryable entry, and it is reserved for failures that genuinely clear
// on their own: 5xx, 429 and transport/timeout.
export const ERROR_TABLE = {
  shopify_not_configured: {
    httpStatus: 503,
    retryable: false,
    message: 'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  },
  shopify_auth_error: {
    httpStatus: 503,
    retryable: false,
    message: 'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  },
  shopify_store_frozen: {
    httpStatus: 503,
    retryable: false,
    message: 'Shopify has frozen this store (unpaid invoice) — the Admin API stays closed until billing is settled. Retrying will not help.',
  },
  shopify_store_locked: {
    httpStatus: 503,
    retryable: false,
    message: 'Shopify has locked this store — the Admin API is closed until Shopify unlocks it. Retrying will not help.',
  },
  shopify_rejected: {
    httpStatus: 503,
    retryable: false,
    message: 'Shopify refused the request — this needs operator attention; retrying the same call will not help.',
  },
  page_not_found: {
    httpStatus: 404,
    retryable: false,
    message: 'That page no longer exists in your store — refresh the list.',
  },
  shopify_unavailable: {
    httpStatus: 503,
    retryable: true,
    message: 'Shopify is temporarily unavailable — try again',
  },
};

/**
 * The failure code for an upstream HTTP status.
 * `notFoundCode` lets the page fetch turn a 404 into the specific
 * `page_not_found` (the list is a SNAPSHOT — a page deleted between listing
 * and clicking is the single most likely 404 here, and it is permanent), while
 * a 404 anywhere else stays the generic "Shopify refused this".
 */
export function codeForStatus(status, { notFoundCode = 'shopify_rejected' } = {}) {
  if (status === 401 || status === 403) return 'shopify_auth_error';
  if (status === 402) return 'shopify_store_frozen';
  if (status === 423) return 'shopify_store_locked';
  if (status === 404) return notFoundCode;
  if (status === 429) return 'shopify_unavailable';
  if (status >= 500) return 'shopify_unavailable';
  if (status >= 400) return 'shopify_rejected';
  return 'shopify_unavailable';
}

function shopifyFailure(reason, code, retryAfter) {
  const err = new ShopifyUnavailableError(reason, code);
  if (retryAfter != null) err.retryAfter = retryAfter;
  return err;
}

/** Seconds from a Retry-After header. Returns null when absent/unusable. */
export function parseRetryAfter(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 3600) : null;
  }
  const when = Date.parse(s); // Shopify may send an HTTP-date
  if (Number.isNaN(when)) return null;
  const secs = Math.ceil((when - Date.now()) / 1000);
  return secs > 0 ? Math.min(secs, 3600) : 0;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the verification harness)
// ---------------------------------------------------------------------------

/**
 * Numeric Shopify page id from either a bare number or a Page gid.
 * `page_id` is interpolated into an Admin REST PATH — `1/../../orders` would
 * walk the Admin API once the URL parser normalises the dot segments — so
 * anything that is not purely digits after the optional gid prefix is refused.
 * Returns '' for anything unusable.
 */
export function numericPageId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(?:gid:\/\/shopify\/Page\/)?(\d{1,20})$/.exec(s);
  return m ? m[1] : '';
}

const ENTITIES = [
  [/&nbsp;/gi, ' '], [/&amp;/gi, '&'], [/&lt;/gi, '<'],
  [/&gt;/gi, '>'], [/&quot;/gi, '"'], [/&#0?39;/g, "'"],
];

/**
 * Visible text of an HTML fragment: script/style bodies dropped, tags
 * stripped, entities decoded, whitespace collapsed. Total function — a null,
 * a number or malformed markup all answer a string.
 */
export function visibleText(html) {
  let out = String(html == null ? '' : html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  for (const [re, to] of ENTITIES) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * B1 — the ONE text extraction a list row gets. Slices the body to
 * BODY_PROBE_BYTES before doing any work, then returns the text plus the
 * number of source characters actually examined (the caller meters those
 * against LIST_BODY_BUDGET_BYTES).
 */
export function deriveRowText(bodyHtml) {
  const src = typeof bodyHtml === 'string' ? bodyHtml : '';
  const probe = src.length > BODY_PROBE_BYTES ? src.slice(0, BODY_PROBE_BYTES) : src;
  return { text: visibleText(probe), probed: probe.length };
}

/**
 * Strip whole-DOCUMENT wrappers from a FRAGMENT.
 *
 * M3 — Shopify's page editor lets an operator paste anything, including a
 * stray `</body>` or a full `<html>` skeleton, into what the API still calls
 * `body_html`. Handing that to the splitter's document heuristics silently
 * truncated the page (measured: one mid-content `</body>` dropped 76.6% of the
 * source, answered 200, and reported nothing). The wrappers are removed here
 * and the split runs in fragment mode, so nothing scopes and nothing is lost.
 * `<main>` is deliberately NOT stripped: fragment mode already stops it from
 * scoping, and the element is real markup the operator wrote.
 * Returns { html, bytesStripped }.
 */
export function stripDocumentWrappers(html) {
  const src = String(html == null ? '' : html);
  const out = src
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<\/?head\b[^>]*>/gi, '')
    .replace(/<\/?body\b[^>]*>/gi, '');
  return {
    html: out,
    bytesStripped: Buffer.byteLength(src, 'utf8') - Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * Pure: Admin REST `pages.json` rows -> the wire shape the picker consumes.
 * Malformed rows are DROPPED (a row with no numeric id is not importable, so
 * offering it would be a dead choice). `body_html` never reaches the wire —
 * only its derived summary and theme-built flag do.
 */
export function mapPageRows(rows, baseUrl) {
  const out = [];
  let probedTotal = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = numericPageId(row.id);
    if (!id) continue;
    const handle = row.handle == null ? '' : String(row.handle);

    // Structurally unreachable while LIST_NODE_MAX x BODY_PROBE_BYTES stays
    // under the budget; it is the backstop for the day one of them moves.
    let summary = '';
    let isThemeBuilt = false;
    if (probedTotal < LIST_BODY_BUDGET_BYTES) {
      const { text, probed } = deriveRowText(row.body_html);
      probedTotal += probed;
      summary = text.slice(0, SUMMARY_MAX);
      isThemeBuilt = text.length < THEME_BUILT_MIN_TEXT;
    }

    out.push({
      id,
      title: row.title == null ? '' : String(row.title),
      handle,
      updated_at: row.updated_at == null ? '' : String(row.updated_at),
      published: row.published_at != null && String(row.published_at).trim() !== '',
      summary,
      is_theme_built: isThemeBuilt,
      live_url: composeLiveUrl(baseUrl, handle),
    });
  }
  return out;
}

/** `{base}/pages/{handle}` — '' when we have no base to build on. */
export function composeLiveUrl(base, handle) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return '';
  const h = String(handle || '').trim();
  return h ? `${b}/pages/${encodeURIComponent(h)}` : b;
}

/**
 * Extract ONLY the `page_info` cursor from a Link header's rel="next" entry.
 * The next URL is rebuilt against our own host from this token — following
 * the header's URL verbatim would let an upstream response redirect our
 * authenticated, token-bearing request at a host of its choosing.
 * Returns '' when there is no next page.
 */
export function nextPageInfo(linkHeader) {
  const header = String(linkHeader == null ? '' : linkHeader);
  for (const part of header.split(',')) {
    if (!/rel\s*=\s*"?next"?/i.test(part)) continue;
    const m = /[?&]page_info=([A-Za-z0-9_\-=.]+)/.exec(part);
    if (m) return m[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Shopify transport
// ---------------------------------------------------------------------------

/**
 * One authenticated Admin REST GET. `path` is caller-built and already
 * validated; nothing user-supplied is interpolated without passing
 * numericPageId() first. Returns { json, headers }.
 * Throws a coded failure for every error class — never a partial.
 */
async function adminGet(path, { notFoundCode } = {}) {
  const { store, token, apiVersion } = shopifyCreds();
  // Missing or malformed config is an OPS outage, not an empty store.
  if (!store || !token || !STORE_HOST_RE.test(store) || !API_VERSION_RE.test(apiVersion)) {
    throw shopifyFailure('not configured', 'shopify_not_configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let resp;
  try {
    resp = await fetch(`https://${store}/admin/api/${apiVersion}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Shopify-Access-Token': token },
      signal: controller.signal,
      redirect: 'error', // never replay the token at a redirected host
    });
  } catch (err) {
    // AbortError (our 8s budget) and DNS/socket failures are one class to the
    // caller: retryable. err.message never carries the token.
    throw shopifyFailure(`fetch_failed ${err.name}`, 'shopify_unavailable');
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw shopifyFailure(
      `http_${resp.status}`,
      codeForStatus(resp.status, { notFoundCode }),
      parseRetryAfter(resp.headers.get('retry-after'))
    );
  }
  let json;
  try {
    json = await resp.json();
  } catch {
    throw shopifyFailure('bad_json', 'shopify_unavailable');
  }
  if (!json || typeof json !== 'object') throw shopifyFailure('bad_json', 'shopify_unavailable');
  return { json, headers: resp.headers };
}

// M1 — resolved storefront domain, memoised per process.
let storefrontCache = null; // { key, base, expiresAt }

/** Harness hook: forget the memoised domain. */
export function resetStorefrontCache() {
  storefrontCache = null;
}

/**
 * The storefront base URL for live links and for absolutizing the relative
 * /cdn/shop/... paths inside body_html.
 *
 * BEST-EFFORT BY DESIGN: this is decoration, so EVERY failure — including a
 * 401/403 — degrades to the configured myshopify host (which serves the same
 * CDN paths) rather than failing the request. m5: a credential failure must
 * surface from the LOAD-BEARING call, which is about to run anyway; raising it
 * from the decorative one only makes the diagnosis depend on which call the
 * cache happened to skip.
 */
async function storefrontBase() {
  const { store, apiVersion } = shopifyCreds();
  const key = `${store}|${apiVersion}`;
  const now = Date.now();
  if (storefrontCache && storefrontCache.key === key && storefrontCache.expiresAt > now) {
    return storefrontCache.base;
  }

  const fallback = store && STORE_HOST_RE.test(store) ? `https://${store}` : '';
  let base = fallback;
  let ttl = STOREFRONT_FAIL_TTL_MS;
  try {
    const { json } = await adminGet('/shop.json?fields=domain,myshopify_domain');
    const shop = json.shop && typeof json.shop === 'object' ? json.shop : {};
    const host = String(shop.domain || shop.myshopify_domain || '').trim();
    if (host && STORE_HOST_RE.test(host)) {
      base = `https://${host}`;
      ttl = STOREFRONT_TTL_MS;
    }
  } catch (err) {
    console.warn('[shopify-pages] shop.json lookup degraded:', err.code || err.name);
  }

  storefrontCache = { key, base, expiresAt: now + ttl };
  return base;
}

// ---------------------------------------------------------------------------
// HTTP handlers (exported so the harness can mount them behind a stub auth
// WITHOUT weakening the real router, which keeps authenticate above)
// ---------------------------------------------------------------------------

const RATE_MESSAGE = 'Too many Shopify requests — wait a moment and try again';

function sendShopifyError(res, err, where) {
  const entry = ERROR_TABLE[err?.code];
  if (entry) {
    console.error(`[shopify-pages] ${where} failed:`, err.code, err.message);
    return res.status(entry.httpStatus).json({
      success: false,
      error: {
        code: err.code,
        // The flag the UI keys its Retry button on, so it never invites a
        // retry against a dead credential, a frozen store or a deleted page.
        retryable: entry.retryable,
        message: entry.message,
        ...(err.retryAfter != null ? { retry_after: err.retryAfter } : {}),
      },
    });
  }
  console.error(`[shopify-pages] ${where} failed:`, err.message);
  return res.status(500).json({
    success: false,
    error: { code: `${where}_failed`, retryable: false, message: 'Shopify request failed' },
  });
}

async function guardRate(req, res) {
  // Fail-OPEN on a limiter outage: a Redis blip must not take the picker
  // down. The Shopify-side budget is the real backstop.
  const rl = await checkRateLimit(
    `shopify-pages:${req.user?.id || req.ip}`,
    PAGES_RATE_MAX,
    PAGES_RATE_WINDOW_SEC
  ).catch(() => ({ allowed: true }));
  if (rl.allowed) return true;
  res.status(429).json({
    success: false,
    // A throttle DOES clear on its own, unlike a dead credential — so it is
    // flagged retryable and the picker keeps offering Try again.
    error: { code: 'rate_limited', retryable: true, message: RATE_MESSAGE, retry_after: rl.retryAfter },
  });
  return false;
}

// GET /api/v1/shopify-pages/list?limit=
// -> 200 { success:true, data:{ pages:[…], store_domain, truncated } }
export async function listHandler(req, res) {
  if (!(await guardRate(req, res))) return undefined;

  const asked = parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(asked) && asked > 0
    ? Math.min(asked, LIST_LIMIT_MAX)
    : LIST_LIMIT_DEFAULT;

  try {
    const base = await storefrontBase();
    const rows = [];
    let cursor = '';
    let truncated = false;
    for (let hop = 0; hop < LIST_HOP_MAX; hop += 1) {
      // m1 — `fields` is carried on EVERY hop. Shopify documents page_info as
      // combinable with `limit` and `fields`; dropping it on hops 2..N pulled
      // the full page objects (every unused column, on every row) for no
      // reason. NOT verifiable against the live store from here — no
      // credentials in this environment — so the harness asserts the shape of
      // OUR request, and a live rejection would surface as shopify_rejected
      // with the status in the log line.
      const qs = cursor
        ? `?limit=${limit}&fields=${REST_FIELDS}&page_info=${encodeURIComponent(cursor)}`
        : `?limit=${limit}&fields=${REST_FIELDS}`;
      const { json, headers } = await adminGet(`/pages.json${qs}`);
      const batch = Array.isArray(json.pages) ? json.pages : [];
      rows.push(...batch);
      cursor = nextPageInfo(headers.get('link'));
      if (!cursor) break;
      if (rows.length >= LIST_NODE_MAX || hop === LIST_HOP_MAX - 1) {
        // We stopped early. Say so — a silently clipped list reads as a
        // census of the store and it is not one.
        truncated = true;
        break;
      }
    }

    const pages = mapPageRows(rows.slice(0, LIST_NODE_MAX), base);
    return res.json({
      success: true,
      data: {
        pages,
        store_domain: base.replace(/^https?:\/\//, ''),
        truncated,
      },
    });
  } catch (err) {
    return sendShopifyError(res, err, 'list');
  }
}

// POST /api/v1/shopify-pages/import  { page_id }
// -> 200 { success:true, data:{ sections, stats, page:{ id,title,handle,live_url } } }
// The `sections` / `stats` shape is byte-for-byte what POST /page-clone/scan
// returns, because it IS that pipeline — the client hands the picked ones
// straight to POST /page-clone/create.
export async function importHandler(req, res) {
  if (!(await guardRate(req, res))) return undefined;

  const pageId = numericPageId((req.body || {}).page_id);
  if (!pageId) {
    return res.status(400).json({
      success: false,
      error: { code: 'page_id_required', retryable: false, message: 'A numeric Shopify page id is required' },
    });
  }

  try {
    const base = await storefrontBase();
    // M2 — the list the operator clicked is a SNAPSHOT. A page deleted since
    // it was drawn is the likeliest 404 here, and no amount of retrying will
    // bring it back, so it gets its own permanent code.
    const { json } = await adminGet(
      `/pages/${pageId}.json?fields=id,title,handle,body_html`,
      { notFoundCode: 'page_not_found' }
    );
    const page = json.page && typeof json.page === 'object' ? json.page : null;
    // A 200 that carries no page object is a FAILED call, not an empty page —
    // reading through it would publish a blank clone as if it were the page.
    if (!page) throw shopifyFailure('no_page_in_body', 'shopify_unavailable');

    const title = page.title == null ? '' : String(page.title);
    const handle = page.handle == null ? '' : String(page.handle);
    const liveUrl = composeLiveUrl(base, handle);
    const body = typeof page.body_html === 'string' ? page.body_html : '';

    if (Buffer.byteLength(body, 'utf8') > INPUT_MAX) {
      return res.status(413).json({
        success: false,
        error: { code: 'source_too_large', retryable: false, message: 'That page exceeds the 10MB scan limit' },
      });
    }

    // M3 — body_html is a FRAGMENT. Document wrappers come off first, then the
    // split runs in fragment mode, so a stray </body> cannot scope the page
    // and silently drop everything after it.
    const wrappers = stripDocumentWrappers(body);

    // THE SAME PIPELINE the paste and upload tabs run. `live_url` is used only
    // as a string base for absolutizing relative /cdn/shop/... paths — nothing
    // is fetched from it (pageClone.js never fetches a URL, by construction).
    const { sections, stats } = scanHtml(wrappers.html, {
      originalUrl: liveUrl || undefined,
      fragment: true,
    });

    if (!sections.length) {
      // m2 — the OBSERVATION, not a diagnosis. A short body is usually a
      // theme-built or page-builder page, but we did not check the theme and
      // will not claim we did.
      return res.status(422).json({
        success: false,
        error: {
          code: 'no_sections',
          retryable: false,
          message:
            'Shopify returned no page content for this page — its live content is rendered somewhere other than the page editor. Open it live, copy the rendered source, and use the Paste code tab.',
          live_url: liveUrl,
        },
      });
    }

    const totalBytes = sections.reduce((n, s) => n + s.approx_bytes, 0);
    if (totalBytes > ESCAPE_HATCH_MAX) {
      return res.status(413).json({
        success: false,
        error: {
          code: 'cleaned_too_large',
          retryable: false,
          message: 'Cleaned page exceeds the 2MB page limit — clone it in smaller pieces',
        },
      });
    }

    // body_html has no <title>, so the Shopify page title is the honest one.
    if (!stats.title && title) stats.title = title;
    // Never silently: if wrappers came off, the count rides back with the scan.
    if (wrappers.bytesStripped > 0) stats.wrapper_bytes_stripped = wrappers.bytesStripped;

    return res.json({
      success: true,
      data: { sections, stats, page: { id: pageId, title, handle, live_url: liveUrl } },
    });
  } catch (err) {
    return sendShopifyError(res, err, 'import');
  }
}

router.use(authenticate, requirePermission('funnels', 'access'));
router.get('/list', listHandler);
router.post('/import', importHandler);

export default router;
