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
export const META_API_VERSION_DEFAULT = 'v21.0';
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
  };
}

const storeConfig = {
  setStoreConfigSource, resetWarnings,
  storeCode, brand, shopifyStoreDomain, shopifyStoreUrl, shopifyApiVersion, SHOPIFY_API_VERSION_DEFAULT, whopCompanyId, tripleWhaleShopId,
  metaApiVersion, metaGraphUrl, META_API_VERSION_DEFAULT, adAccounts, adAccountNames, adAccountName, frameioToken,
  timezone, TIMEZONE_DEFAULT, slackChannels,
  snapshot,
};
export default storeConfig;
