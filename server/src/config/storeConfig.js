// STORE CONFIG — the ONE place dashboard server code reads store identity.
//
// Rules this module exists for (RULES.md): R5 store identity is data, not a
// build; R7 flags and credentials are read at REQUEST time, never at import;
// R15 no product / store / brand literal in engine code. Every getter below
// reads process.env when it is CALLED. Nothing is cached except the
// "already warned" set, so a value changed on Render takes effect on the next
// request and rollback = unset a variable.
//
// FAIL CLOSED: an unset or malformed key yields null / [] / the documented
// non-store default, plus ONE warning naming the key. It never yields another
// store's value. There are deliberately no brand, store, colour, ad-account,
// channel or domain literals in this file — the reviewer greps for them (A1).
//
// PRODUCT_CODES_JSON is the exception to "warn and carry on": it is REQUIRED.
// An empty catalogue is not a dormant feature, it is a routing hazard — with
// no catalogue clickupWebhook.js fell through to the PL Frame.io project and
// renamed live ClickUp cards (REVIEW-LANE-F.md P1-1). So productCodes()
// THROWS a StoreConfigError instead of returning {}, and assertBootConfig()
// is called from server.js before anything listens: the process refuses to
// start rather than run with a silently empty catalogue.
//
// ── Manifest adapter seam ────────────────────────────────────────────────
// Today the source is process.env. The hub manifest (plan Section 13) will
// supply the same keys per store. To switch, call
//   setStoreConfigSource((key) => manifest.valueFor(storeCode, key))
// once at boot: the adapter is consulted FIRST for every key and falls
// through to process.env when it returns undefined/null, so a partial
// manifest and a plain env deploy behave identically. Pass null to remove.
//
// Secrets (Frame.io token) are read here too so there is one read site, but
// they are NEVER part of snapshot() and never reach /api/v1/store-config.

let manifestSource = null;
const warned = new Set();

/** A required store-config key is missing or malformed. Refuses boot. */
export class StoreConfigError extends Error {
  constructor(message) { super(message); this.name = 'StoreConfigError'; }
}

export function setStoreConfigSource(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new TypeError('setStoreConfigSource expects a function (key → value) or null');
  }
  manifestSource = fn;
}

/** Test hook: forget which keys have already warned. */
export function resetWarnings() { warned.clear(); }

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[storeConfig] ${key}: ${message}`);
}

function raw(key) {
  if (manifestSource) {
    const v = manifestSource(key);
    if (v !== undefined && v !== null) return String(v);
  }
  const v = process.env[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  // Blank = unset. NOT trimmed otherwise: a stray space in a value that is
  // interpolated into a URL path is a misconfiguration the validators below
  // must SEE, not one this layer quietly repairs.
  return s.trim() === '' ? undefined : s;
}

/** Non-secret string; unset → null with one warning (unless silent). */
function readString(key, { silent = false, unsetMessage } = {}) {
  const v = raw(key);
  if (v === undefined) {
    if (!silent) warnOnce(key, unsetMessage || 'not set — feature dormant until it is');
    return null;
  }
  return v;
}

// ── Store / brand ───────────────────────────────────────────────────────

/** Store code (PL, MB, …). Partitions every shared account. */
export function storeCode() {
  const v = readString('STORE_CODE', { unsetMessage: 'not set — this deployment has no store code; set STORE_CODE' });
  return v ? v.toUpperCase() : null;
}

/**
 * Public brand identity for the client. Unset keys are null: the client keeps
 * its build-time fallback (client/src/config/brand.js), which is where the
 * historical defaults live. No default here — that would be a brand literal.
 */
export function brand() {
  return {
    name: readString('BRAND_NAME', { silent: true }),
    shortName: readString('BRAND_SHORT_NAME', { silent: true }),
    logoWhite: readString('BRAND_LOGO_WHITE', { silent: true }),
    logoSymbol: readString('BRAND_LOGO_SYMBOL', { silent: true }),
    logoBlack: readString('BRAND_LOGO_BLACK', { silent: true }),
    emailDomain: readString('BRAND_EMAIL_DOMAIN', { silent: true }),
  };
}

// ── Hub (multi-store) ───────────────────────────────────────────────────

/**
 * Where this store's hub lives and whether the SSO door is open. Both read at REQUEST time (R7), both
 * non-secret: HUB_ORIGIN is a public url and the flag is a boolean. The SECRET that signs hub tickets
 * (HUB_SSO_SECRET) is deliberately NOT read here and never appears in the snapshot.
 *
 * origin null = no hub configured on this deployment. The client renders its plain brand block and no
 * switcher: a store must work on its own login with the hub gone (R21).
 */
export function hub() {
  return {
    origin: readString('HUB_ORIGIN', { silent: true }),
    sso_enabled: raw('HUB_SSO_ENABLED') === '1',
  };
}

// ── Shopify ─────────────────────────────────────────────────────────────

/** `<shop>.myshopify.com`; unset → null (one warning). */
export function shopifyStoreDomain() {
  return readString('SHOPIFY_STORE_DOMAIN', { unsetMessage: 'not set — Shopify Admin calls are dormant on this deployment' });
}

/** The store's public URL (`https://…`, no trailing slash); unset → null (one warning). */
export function shopifyStoreUrl() {
  const v = readString('SHOPIFY_STORE_URL', { unsetMessage: 'not set — no landing-page fallback; ad launches without a product URL are refused' });
  return v ? v.replace(/\/+$/, '') : null;
}

/** The ONE place the Shopify Admin API version defaults. */
export const SHOPIFY_API_VERSION_DEFAULT = '2024-01';
const SHOPIFY_API_VERSION_RE = /^\d{4}-\d{2}$/;

/**
 * Shopify Admin API version (`YYYY-MM`). UNSET → the one default. MALFORMED
 * (anything that is not exactly YYYY-MM — a path fragment, a stray space,
 * 'latest') → null + one warning: it is a misconfiguration every caller must
 * refuse, never a value this layer repairs into a URL path.
 */
export function shopifyApiVersion() {
  const v = raw('SHOPIFY_API_VERSION');
  if (v === undefined) return SHOPIFY_API_VERSION_DEFAULT;
  if (!SHOPIFY_API_VERSION_RE.test(v)) {
    warnOnce('SHOPIFY_API_VERSION', `${JSON.stringify(v.slice(0, 20))} is not a Shopify version (YYYY-MM) — Shopify calls are refused until it is fixed`);
    return null;
  }
  return v;
}

// ── Meta ────────────────────────────────────────────────────────────────

/** The ONE place the Meta Graph API version defaults. */
// The newest Graph version already in use in this tree. A single env cannot
// reproduce the pre-existing v21/v22/v23 spread, so the default is the newest
// (longest sunset runway), not the oldest (REVIEW-LANE-F.md P1-2). Per-store
// override: META_API_VERSION.
export const META_API_VERSION_DEFAULT = 'v23.0';
const META_API_VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;

/** Meta Graph API version (`vNN.N`); malformed → default + one warning. */
export function metaApiVersion() {
  const v = raw('META_API_VERSION');
  if (v === undefined) return META_API_VERSION_DEFAULT;
  if (!META_API_VERSION_RE.test(v)) {
    warnOnce('META_API_VERSION', `'${v.slice(0, 20)}' is not a Graph version (vNN.N) — using ${META_API_VERSION_DEFAULT}`);
    return META_API_VERSION_DEFAULT;
  }
  return v;
}

const AD_ACCOUNT_ID_RE = /^act_\d+$/;

/**
 * Meta ad accounts this store owns, from env META_AD_ACCOUNTS_JSON:
 *   [{ "id": "act_<digits>", "name": "<display name>" }, …]
 * Unset or malformed (bad JSON, not an array, an entry without an act_ id or
 * a string name) → [] with one warning. Names are DISPLAY data; the ids that
 * gate API calls still come from META_AD_ACCOUNT_IDS in each module.
 */
export function adAccounts() {
  const rawJson = raw('META_AD_ACCOUNTS_JSON');
  if (rawJson === undefined) {
    warnOnce('META_AD_ACCOUNTS_JSON', 'not set — ad accounts will display by raw id');
    return [];
  }
  let parsed;
  try { parsed = JSON.parse(rawJson); } catch (e) {
    warnOnce('META_AD_ACCOUNTS_JSON', `is not valid JSON (${e.message}) — ad accounts ignored`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnOnce('META_AD_ACCOUNTS_JSON', 'must be a JSON array of {id, name} — ad accounts ignored');
    return [];
  }
  const out = [];
  for (const entry of parsed) {
    const id = entry && typeof entry.id === 'string' ? entry.id : null;
    const name = entry && typeof entry.name === 'string' ? entry.name : null;
    if (!id || !AD_ACCOUNT_ID_RE.test(id) || !name) {
      warnOnce('META_AD_ACCOUNTS_JSON', `entry ${JSON.stringify(entry).slice(0, 60)} is not {id: "act_<digits>", name: string} — ad accounts ignored`);
      return [];
    }
    out.push({ id, name });
  }
  return out;
}

/** `{ act_<id>: name }` for display lookups. */
export function adAccountNames() {
  return Object.fromEntries(adAccounts().map((a) => [a.id, a.name]));
}

/** Display name for an ad account id; the id itself when unknown. */
export function adAccountName(id) {
  return adAccountNames()[id] || id;
}

/** `https://graph.facebook.com/<version>` — the base every Graph call is built on. */
export function metaGraphUrl() {
  return `https://graph.facebook.com/${metaApiVersion()}`;
}

// ── Frame.io (SECRET — never in snapshot) ───────────────────────────────

/**
 * Frame.io API token. Canonical env: FRAMEIO_TOKEN. The two historical names
 * (FRAME_IO_TOKEN, FRAMEIO_API_TOKEN) are honoured for ONE release with a
 * deprecation warning each; unset → '' with one warning (integration dormant).
 */
export function frameioToken() {
  const canonical = raw('FRAMEIO_TOKEN');
  if (canonical !== undefined) return canonical;
  for (const legacy of ['FRAME_IO_TOKEN', 'FRAMEIO_API_TOKEN']) {
    const v = raw(legacy);
    if (v !== undefined) {
      warnOnce(legacy, 'is DEPRECATED — rename it to FRAMEIO_TOKEN (still honoured this release)');
      return v;
    }
  }
  warnOnce('FRAMEIO_TOKEN', 'not set — Frame.io integration is dormant on this deployment');
  return '';
}

// ── Triple Whale ────────────────────────────────────────────────────────

/** Triple Whale shop id; NO literal default — unset = feature dormant (one warning). */
export function tripleWhaleShopId() {
  return readString('TRIPLEWHALE_SHOP_ID', { unsetMessage: 'not set — Triple Whale queries are dormant on this deployment' });
}

// ── Whop ────────────────────────────────────────────────────────────────

/** Whop company id (`biz_…`); unset → null (one warning). */
export function whopCompanyId() {
  return readString('WHOP_COMPANY_ID', { unsetMessage: 'not set — Whop company-scoped calls are dormant on this deployment' });
}

// ── Product codes ───────────────────────────────────────────────────────
//
// env PRODUCT_CODES_JSON = {
//   "<CODE>": {
//     "default": true,                 // at most one; used for unknown codes
//     "aliases": ["<other code>"],     // e.g. a DB product_code that maps here
//     "namingCode": "<CODE>" | null,   // code that leads the naming convention
//     "fbPage": "<FB Page option>" | null,
//     "clickup": { "videoListId", "staticListId", "mediaBuyingListId",
//                  "initialStatus", "productId" },   // productId = the ClickUp
//                  // Product-relationship item that routes a card to this code
//     "frameio": { "projectId", "editingFolderId", "staticEditingFolderId" }
//   }, …
// }
// Every field is optional and null when absent. PRODUCT_CODES_JSON is REQUIRED:
// unset or malformed THROWS StoreConfigError (boot refuses — see the header).
// There is no empty-catalogue mode, because an empty catalogue made card
// routing fall through to another product's Frame.io project.

const STR_OR_NULL = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const CODE_RE = /^[A-Z0-9]{1,8}$/;

function normaliseProduct(code, e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`entry ${code} must be an object`);
  for (const k of ['clickup', 'frameio']) {
    if (e[k] !== undefined && (!e[k] || typeof e[k] !== 'object' || Array.isArray(e[k]))) throw new Error(`entry ${code}.${k} must be an object`);
  }
  const aliases = e.aliases === undefined ? [] : e.aliases;
  if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === 'string' && a.trim() !== '')) throw new Error(`entry ${code}.aliases must be an array of strings`);
  const cu = e.clickup || {};
  const fr = e.frameio || {};
  return {
    code,
    aliases: aliases.map((a) => a.trim().toUpperCase()),
    default: e.default === true,
    namingCode: STR_OR_NULL(e.namingCode),
    fbPage: STR_OR_NULL(e.fbPage),
    clickup: {
      videoListId: STR_OR_NULL(cu.videoListId),
      staticListId: STR_OR_NULL(cu.staticListId),
      mediaBuyingListId: STR_OR_NULL(cu.mediaBuyingListId),
      initialStatus: STR_OR_NULL(cu.initialStatus),
      productId: STR_OR_NULL(cu.productId),
    },
    frameio: {
      projectId: STR_OR_NULL(fr.projectId),
      editingFolderId: STR_OR_NULL(fr.editingFolderId),
      staticEditingFolderId: STR_OR_NULL(fr.staticEditingFolderId),
    },
  };
}

const PRODUCT_CODES_HELP =
  'Set it to a JSON object keyed by product code, e.g. '
  + '{"<CODE>":{"default":true,"clickup":{"videoListId":"…","initialStatus":"edit queue"},"frameio":{"projectId":"…","editingFolderId":"…"}}} '
  + '— see server/config/env.<STORE>.example for this store\'s exact value.';

/**
 * `{ CODE: entry }`, validated and normalised.
 * REQUIRED: unset or malformed throws StoreConfigError. There is no empty
 * catalogue — see the file header and assertBootConfig().
 */
export function productCodes() {
  const rawJson = raw('PRODUCT_CODES_JSON');
  if (rawJson === undefined) {
    throw new StoreConfigError(
      `PRODUCT_CODES_JSON is not set. It is REQUIRED: without it product cards cannot be routed and the old code fell back to another product's ClickUp list and Frame.io project. ${PRODUCT_CODES_HELP}`,
    );
  }
  let out;
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object keyed by product code');
    out = {};
    let defaults = 0;
    for (const [code, entry] of Object.entries(parsed)) {
      if (!CODE_RE.test(code)) throw new Error(`key ${JSON.stringify(code)} is not an upper-case product code`);
      out[code] = normaliseProduct(code, entry);
      if (out[code].default) defaults += 1;
    }
    if (defaults > 1) throw new Error('more than one entry is marked default');
    // `{}` parses, but an empty catalogue is the very state this key exists to
    // prevent — it is a typo or a half-written value, not a configuration.
    if (Object.keys(out).length === 0) throw new Error('is an EMPTY catalogue ({}) — at least one product code is required');
  } catch (e) {
    throw new StoreConfigError(`PRODUCT_CODES_JSON is invalid: ${e.message}. ${PRODUCT_CODES_HELP}`);
  }
  return out;
}

/**
 * Boot gate (R5/R15). Called once from server.js BEFORE anything listens:
 * every key this deployment cannot run without is resolved here, and the
 * process refuses to start when one is missing or malformed. Keys that are
 * genuinely optional stay in the warn-once path and are NOT listed here.
 */
const REQUIRED_AT_BOOT = [['PRODUCT_CODES_JSON', productCodes]];

export function assertBootConfig() {
  const problems = [];
  for (const [key, getter] of REQUIRED_AT_BOOT) {
    try { getter(); } catch (e) { problems.push(`${e.message}`); void key; }
  }
  if (problems.length) throw new StoreConfigError(problems.join(' | '));
  return { ok: true, checked: REQUIRED_AT_BOOT.map(([k]) => k) };
}

/** The entry marked `default`, or null. */
export function defaultProduct() {
  return Object.values(productCodes()).find((p) => p.default) || null;
}

/**
 * Entry for a product code or alias (case-insensitive); unknown → the default
 * entry; no default → null (the caller refuses — never a guessed pipeline).
 */
export function productFor(code) {
  const c = String(code || '').trim().toUpperCase();
  const all = productCodes();
  if (c && all[c]) return all[c];
  if (c) {
    const byAlias = Object.values(all).find((p) => p.aliases.includes(c));
    if (byAlias) return byAlias;
  }
  return Object.values(all).find((p) => p.default) || null;
}

/**
 * Entry for a ClickUp Product-relationship item ({id, name}): matches an
 * entry that DECLARES clickup.productId, by id (rename-safe) or by the code
 * as the item's name. Entries without a productId are never matched.
 */
export function productForClickupProductRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const id = typeof ref.id === 'string' ? ref.id : null;
  const name = String(ref.name || '').trim().toUpperCase();
  return Object.values(productCodes()).find((p) => p.clickup.productId && (p.clickup.productId === id || p.code === name)) || null;
}

// ── Slack ───────────────────────────────────────────────────────────────

/**
 * Slack channel ids this store posts to. Each unset key → null (one warning)
 * and the corresponding post is skipped. `editors` is env
 * SLACK_EDITOR_CHANNELS_JSON = { "<editor name>": "C0…", … }; malformed → {}.
 */
export function slackChannels() {
  let editors = {};
  const rawJson = raw('SLACK_EDITOR_CHANNELS_JSON');
  if (rawJson === undefined) {
    warnOnce('SLACK_EDITOR_CHANNELS_JSON', 'not set — editor weekly reports are dormant');
  } else {
    try {
      const parsed = JSON.parse(rawJson);
      const ok = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.values(parsed).every((v) => typeof v === 'string' && v.trim() !== '');
      if (!ok) throw new Error('must be {"<editor>": "<channel id>", …}');
      editors = { ...parsed };
    } catch (e) {
      warnOnce('SLACK_EDITOR_CHANNELS_JSON', `is not a valid editor→channel map (${e.message}) — editor reports dormant`);
    }
  }
  return {
    pnl: readString('SLACK_PNL_CHANNEL', { unsetMessage: 'not set — P&L Slack posts are skipped' }),
    kpi: readString('SLACK_KPI_CHANNEL', { unsetMessage: 'not set — KPI/supply-chain Slack alerts are skipped' }),
    rejection: readString('SLACK_REJECTION_CHANNEL', { unsetMessage: 'not set — ad-rejection Slack alerts are skipped' }),
    editors,
  };
}

// ── Reporting timezone ──────────────────────────────────────────────────

/** The ONE place the report timezone defaults. */
export const TIMEZONE_DEFAULT = 'Europe/Madrid';

/**
 * IANA report timezone (REPORT_TZ). Validated against Intl: an invalid zone
 * THROWS naming the key — this string reaches Postgres `AT TIME ZONE` and
 * Intl, and a silent default would mis-bucket money, so it fails closed hard.
 */
export function timezone() {
  const want = (raw('REPORT_TZ') ?? TIMEZONE_DEFAULT).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: want });
    return want;
  } catch {
    throw new Error(`REPORT_TZ '${want.slice(0, 60)}' is not a valid IANA timezone`);
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────

/**
 * Everything non-secret, in one object. This is what GET /api/v1/store-config
 * returns and what the per-store snapshot test (A2) compares against.
 * Secrets are excluded by construction: only the getters listed here run.
 */
export function snapshot() {
  return {
    storeCode: storeCode(),
    brand: brand(),
    hub: hub(),
    shopify: {
      storeDomain: shopifyStoreDomain(),
      storeUrl: shopifyStoreUrl(),
      apiVersion: shopifyApiVersion(),
    },
    whop: {
      companyId: whopCompanyId(),
    },
    tripleWhale: {
      shopId: tripleWhaleShopId(),
    },
    meta: {
      apiVersion: metaApiVersion(),
      adAccounts: adAccounts(),
    },
    slack: slackChannels(),
    timezone: timezone(),
    productCodes: productCodes(),
  };
}

const storeConfig = {
  setStoreConfigSource, resetWarnings,
  storeCode, brand, hub, shopifyStoreDomain, shopifyStoreUrl, shopifyApiVersion, SHOPIFY_API_VERSION_DEFAULT, whopCompanyId, tripleWhaleShopId,
  metaApiVersion, metaGraphUrl, META_API_VERSION_DEFAULT, adAccounts, adAccountNames, adAccountName, frameioToken,
  timezone, TIMEZONE_DEFAULT, slackChannels,
  productCodes, defaultProduct, productFor, productForClickupProductRef,
  snapshot, assertBootConfig, StoreConfigError,
};
export default storeConfig;
