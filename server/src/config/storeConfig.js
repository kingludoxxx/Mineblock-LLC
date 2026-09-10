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
  const s = String(v).trim();
  return s === '' ? undefined : s;
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

// ── Shopify ─────────────────────────────────────────────────────────────

/** `<shop>.myshopify.com`; unset → null (one warning). */
export function shopifyStoreDomain() {
  return readString('SHOPIFY_STORE_DOMAIN', { unsetMessage: 'not set — Shopify Admin calls are dormant on this deployment' });
}

/** The ONE place the Shopify Admin API version defaults. */
export const SHOPIFY_API_VERSION_DEFAULT = '2024-01';
const SHOPIFY_API_VERSION_RE = /^\d{4}-(01|04|07|10)$/;

/** Shopify Admin API version (`YYYY-01|04|07|10`); malformed → default + one warning. */
export function shopifyApiVersion() {
  const v = raw('SHOPIFY_API_VERSION');
  if (v === undefined) return SHOPIFY_API_VERSION_DEFAULT;
  if (!SHOPIFY_API_VERSION_RE.test(v)) {
    warnOnce('SHOPIFY_API_VERSION', `'${v.slice(0, 20)}' is not a Shopify version (YYYY-01|04|07|10) — using ${SHOPIFY_API_VERSION_DEFAULT}`);
    return SHOPIFY_API_VERSION_DEFAULT;
  }
  return v;
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
    shopify: {
      storeDomain: shopifyStoreDomain(),
      apiVersion: shopifyApiVersion(),
    },
    whop: {
      companyId: whopCompanyId(),
    },
    tripleWhale: {
      shopId: tripleWhaleShopId(),
    },
  };
}

const storeConfig = {
  setStoreConfigSource, resetWarnings,
  storeCode, brand, shopifyStoreDomain, shopifyApiVersion, SHOPIFY_API_VERSION_DEFAULT, whopCompanyId, tripleWhaleShopId,
  snapshot,
};
export default storeConfig;
