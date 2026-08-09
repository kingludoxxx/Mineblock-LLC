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
// FAILURE SEMANTICS (do not conflate) — a Shopify outage must read as an
// outage, NEVER as "this store has no pages". An empty `pages: []` is a
// POSITIVE claim about the store:
//   store/token not configured -> 503 {code:'shopify_not_configured', retryable:false}
//   Shopify 401/403            -> 503 {code:'shopify_auth_error',     retryable:false}
//   transport/timeout/5xx/429  -> 503 {code:'shopify_unavailable',    retryable:true}
//   page has no editor content -> 422 {code:'theme_built'}  (actionable, not an outage)
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

// A page whose body_html carries less visible text than this has no content
// in Shopify's page editor — the real page is built by the theme or a page
// builder (GemPages / PageFly / Shogun). We refuse it with an actionable
// message instead of importing an empty shell.
export const THEME_BUILT_MIN_TEXT = 200;

export const SUMMARY_MAX = 160;

// A hostname, nothing more. A store value carrying a path or credentials
// would smuggle itself into the request URL, so it is refused as "not
// configured" rather than half-trusted.
const STORE_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

function shopifyCreds() {
  return {
    store: process.env.PUURE_SHOPIFY_STORE || process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.PUURE_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
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

/** One-line preview of a page body, capped at SUMMARY_MAX characters. */
export function summarize(html, max = SUMMARY_MAX) {
  return visibleText(html).slice(0, max);
}

/**
 * Pure: an Admin REST `pages.json` row -> the wire shape the picker consumes.
 * Malformed rows are DROPPED (a row with no numeric id is not importable, so
 * offering it would be a dead choice). `body_html` never reaches the wire —
 * only its derived summary and theme-built flag do.
 */
export function mapPageRows(rows, baseUrl) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = numericPageId(row.id);
    if (!id) continue;
    const handle = row.handle == null ? '' : String(row.handle);
    const body = typeof row.body_html === 'string' ? row.body_html : '';
    out.push({
      id,
      title: row.title == null ? '' : String(row.title),
      handle,
      updated_at: row.updated_at == null ? '' : String(row.updated_at),
      published: row.published_at != null && String(row.published_at).trim() !== '',
      summary: summarize(body),
      is_theme_built: visibleText(body).length < THEME_BUILT_MIN_TEXT,
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
 * Throws ShopifyUnavailableError for every failure class — never a partial.
 */
async function adminGet(path) {
  const { store, token, apiVersion } = shopifyCreds();
  // Missing or malformed config is an OPS outage, not an empty store.
  if (!store || !token || !STORE_HOST_RE.test(store)) {
    throw new ShopifyUnavailableError('not configured', 'shopify_not_configured');
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
    throw new ShopifyUnavailableError(`fetch_failed ${err.name}`);
  } finally {
    clearTimeout(timer);
  }
  // A 401/403 is a REVOKED OR WRONG CREDENTIAL. It will not fix itself, so it
  // must not be dressed up as a retryable blip behind a Retry button.
  if (resp.status === 401 || resp.status === 403) {
    throw new ShopifyUnavailableError(`http_${resp.status}`, 'shopify_auth_error');
  }
  if (!resp.ok) throw new ShopifyUnavailableError(`http_${resp.status}`);
  let json;
  try {
    json = await resp.json();
  } catch {
    throw new ShopifyUnavailableError('bad_json');
  }
  if (!json || typeof json !== 'object') throw new ShopifyUnavailableError('bad_json');
  return { json, headers: resp.headers };
}

/**
 * The storefront base URL for live links and for absolutizing the relative
 * /cdn/shop/... paths inside body_html.
 *
 * BEST-EFFORT BY DESIGN: this is decoration, so a failure here degrades to
 * the configured myshopify host (which serves the same CDN paths) instead of
 * failing the import. The PAGE fetch is the load-bearing call and keeps full
 * outage semantics.
 */
async function storefrontBase() {
  const { store } = shopifyCreds();
  const fallback = store && STORE_HOST_RE.test(store) ? `https://${store}` : '';
  try {
    const { json } = await adminGet('/shop.json?fields=domain,myshopify_domain');
    const shop = json.shop && typeof json.shop === 'object' ? json.shop : {};
    const host = String(shop.domain || shop.myshopify_domain || '').trim();
    if (host && STORE_HOST_RE.test(host)) return `https://${host}`;
  } catch (err) {
    // A dead credential still needs to surface, so re-throw the two classes
    // that a retry cannot fix; a blip on a decorative call does not.
    if (err instanceof ShopifyUnavailableError && err.code !== 'shopify_unavailable') throw err;
    console.warn('[shopify-pages] shop.json lookup degraded:', err.code || err.name);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// HTTP handlers (exported so the harness can mount them behind a stub auth
// WITHOUT weakening the real router, which keeps authenticate above)
// ---------------------------------------------------------------------------

const RATE_MESSAGE = 'Too many Shopify requests — wait a moment and try again';

const ERROR_MESSAGES = {
  shopify_not_configured:
    'Shopify is not configured on this environment — this needs operator attention, retrying will not help.',
  shopify_auth_error:
    'Shopify rejected our credentials — the access token is missing, expired or revoked. This needs operator attention; retrying will not help.',
  shopify_unavailable: 'Shopify is temporarily unavailable — try again',
};

function sendShopifyError(res, err, where) {
  if (err instanceof ShopifyUnavailableError) {
    console.error(`[shopify-pages] ${where} unavailable:`, err.code, err.message);
    return res.status(503).json({
      success: false,
      error: {
        code: err.code,
        // The flag the UI keys its Retry button on, so it never invites a
        // retry against a credential that will keep failing.
        retryable: err.code === 'shopify_unavailable',
        message: ERROR_MESSAGES[err.code] || ERROR_MESSAGES.shopify_unavailable,
      },
    });
  }
  console.error(`[shopify-pages] ${where} failed:`, err.message);
  return res.status(500).json({
    success: false,
    error: { code: `${where}_failed`, message: 'Shopify request failed' },
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
      const qs = cursor
        // Shopify refuses every other filter alongside page_info.
        ? `?limit=${limit}&page_info=${encodeURIComponent(cursor)}`
        : `?limit=${limit}&fields=id,title,handle,updated_at,published_at,body_html`;
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
      error: { code: 'page_id_required', message: 'A numeric Shopify page id is required' },
    });
  }

  try {
    const base = await storefrontBase();
    const { json } = await adminGet(
      `/pages/${pageId}.json?fields=id,title,handle,body_html`
    );
    const page = json.page && typeof json.page === 'object' ? json.page : null;
    // A 200 that carries no page object is a FAILED call, not an empty page —
    // reading through it would publish a blank clone as if it were the page.
    if (!page) throw new ShopifyUnavailableError('no_page_in_body');

    const title = page.title == null ? '' : String(page.title);
    const handle = page.handle == null ? '' : String(page.handle);
    const liveUrl = composeLiveUrl(base, handle);
    const body = typeof page.body_html === 'string' ? page.body_html : '';

    if (Buffer.byteLength(body, 'utf8') > INPUT_MAX) {
      return res.status(413).json({
        success: false,
        error: { code: 'source_too_large', message: 'That page exceeds the 10MB scan limit' },
      });
    }

    if (visibleText(body).length < THEME_BUILT_MIN_TEXT) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'theme_built',
          retryable: false,
          message:
            'This page has no content in Shopify’s page editor — it is built by your theme or a page builder. Open it live, copy the rendered source, and use the Paste code tab.',
          live_url: liveUrl,
        },
      });
    }

    // THE SAME PIPELINE the paste and upload tabs run. `live_url` is used only
    // as a string base for absolutizing relative /cdn/shop/... paths — nothing
    // is fetched from it (pageClone.js never fetches a URL, by construction).
    const { sections, stats } = scanHtml(`<body>${body}</body>`, {
      originalUrl: liveUrl || undefined,
    });

    if (!sections.length) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'no_sections',
          retryable: false,
          message: 'The scan found no content sections in that page',
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
          message: 'Cleaned page exceeds the 2MB page limit — clone it in smaller pieces',
        },
      });
    }

    // body_html has no <title>, so the Shopify page title is the honest one.
    if (!stats.title && title) stats.title = title;

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
