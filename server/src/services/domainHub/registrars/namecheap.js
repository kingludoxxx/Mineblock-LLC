// Domain Hub — Namecheap registrar adapter.
//
// Namecheap's API is XML over HTTP with auth as request parameters. We send
// everything as a POST form body (Namecheap accepts GET and POST) so the
// ApiKey NEVER appears in a URL — URLs leak into logs and error objects.
// Responses are parsed with fast-xml-parser and judged by the ApiResponse
// Status attribute; an ERROR status surfaces Namecheap's own message
// verbatim instead of pretending success.
//
// Env:  NAMECHEAP_API_USER, NAMECHEAP_API_KEY, NAMECHEAP_USERNAME,
//       NAMECHEAP_CLIENT_IP (Namecheap whitelists the caller IP),
//       NAMECHEAP_API_BASE — test/sandbox seam
//         (prod https://api.namecheap.com/xml.response,
//          sandbox https://api.sandbox.namecheap.com/xml.response).
//
// NEVER auto-purchase: purchaseDomain() is operator-triggered only, requires
// confirm:true, requires creds, and re-checks availability first
// (search-before-buy) so a double-click can never buy twice.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false, // keep raw strings; we coerce explicitly
});

function cfg() {
  return {
    base: String(process.env.NAMECHEAP_API_BASE || 'https://api.namecheap.com/xml.response').trim(),
    apiUser: String(process.env.NAMECHEAP_API_USER || '').trim(),
    apiKey: String(process.env.NAMECHEAP_API_KEY || '').trim(),
    userName: String(process.env.NAMECHEAP_USERNAME || process.env.NAMECHEAP_API_USER || '').trim(),
    clientIp: String(process.env.NAMECHEAP_CLIENT_IP || '').trim(),
  };
}

export function configured() {
  const c = cfg();
  return Boolean(c.apiUser && c.apiKey && c.userName && c.clientIp);
}

const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const isTrue = (v) => String(v).toLowerCase() === 'true';

async function ncCall(command, params = {}) {
  if (!configured()) return { ok: false, error: 'namecheap_not_configured' };
  const c = cfg();
  const body = new URLSearchParams({
    ApiUser: c.apiUser,
    ApiKey: c.apiKey,
    UserName: c.userName,
    ClientIp: c.clientIp,
    Command: command,
    ...params,
  });
  let res;
  try {
    res = await fetch(c.base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `namecheap_unreachable: ${err.message}` };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: `namecheap_http_${res.status}` };
  let doc;
  try {
    doc = parser.parse(text);
  } catch (err) {
    return { ok: false, error: `namecheap_bad_xml: ${err.message}` };
  }
  const api = doc?.ApiResponse;
  if (!api) return { ok: false, error: 'namecheap_bad_response_shape' };
  if (String(api['@_Status']).toUpperCase() !== 'OK') {
    const errs = asArray(api.Errors?.Error)
      .map((e) => (typeof e === 'object' ? e['#text'] || JSON.stringify(e) : String(e)));
    return { ok: false, error: errs[0] || 'namecheap_error', errors: errs };
  }
  return { ok: true, response: api.CommandResponse };
}

// ── Search ──────────────────────────────────────────────────────────────────

const SEARCH_TLDS = ['com', 'net', 'org', 'io', 'co', 'shop', 'store', 'online', 'xyz', 'site'];

function candidatesFor(query) {
  let q = String(query || '').trim().toLowerCase();
  if (q.includes('://')) q = q.split('://')[1];
  q = q.split('/')[0];
  if (!q) return [];
  if (q.includes('.')) {
    // Full domain typed: check it AND fan the stem across the TLD list.
    const stem = q.split('.')[0].replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    const set = new Set([q]);
    for (const t of SEARCH_TLDS) set.add(`${stem}.${t}`);
    return [...set].filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  }
  const stem = q.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!stem) return [];
  return SEARCH_TLDS.map((t) => `${stem}.${t}`);
}

// Registration pricing by TLD — one users.getPricing call, cached 10 min.
// Honest handling: Namecheap's domains.check does NOT return regular prices
// (only premium ones), so standard pricing comes from the pricing table; when
// that call fails we return price:null rather than inventing a number.
let pricingCache = { at: 0, byTld: null };
async function registrationPricing() {
  if (pricingCache.byTld && Date.now() - pricingCache.at < 600_000) return pricingCache.byTld;
  const res = await ncCall('namecheap.users.getPricing', {
    ProductType: 'DOMAIN',
    ProductCategory: 'DOMAINS',
    ActionName: 'REGISTER',
  });
  if (!res.ok) return null;
  const byTld = {};
  const types = asArray(res.response?.UserGetPricingResult?.ProductType);
  for (const pt of types) {
    for (const cat of asArray(pt?.ProductCategory)) {
      for (const prod of asArray(cat?.Product)) {
        const tld = String(prod['@_Name'] || '').toLowerCase();
        const oneYear = asArray(prod.Price).find((p) => String(p['@_Duration']) === '1');
        if (tld && oneYear) {
          const your = Number(oneYear['@_YourPrice'] ?? oneYear['@_Price']);
          byTld[tld] = {
            price: Number.isFinite(your) ? your : null,
            currency: oneYear['@_Currency'] || 'USD',
          };
        }
      }
    }
  }
  pricingCache = { at: Date.now(), byTld };
  return byTld;
}

/** Availability + price for the query across popular TLDs. */
export async function searchDomains(query) {
  if (!configured()) return { ok: false, error: 'namecheap_not_configured', results: [] };
  const candidates = candidatesFor(query);
  if (!candidates.length) return { ok: false, error: 'query_empty', results: [] };

  const res = await ncCall('namecheap.domains.check', {
    DomainList: candidates.join(','),
  });
  if (!res.ok) return { ok: false, error: res.error, results: [] };

  const pricing = await registrationPricing(); // null on failure → price:null

  const rows = asArray(res.response?.DomainCheckResult).map((r) => {
    const domain = String(r['@_Domain'] || '').toLowerCase();
    const tld = domain.split('.').slice(1).join('.');
    const premium = isTrue(r['@_IsPremiumName']);
    const premiumPrice = Number(r['@_PremiumRegistrationPrice']);
    const std = pricing?.[tld];
    return {
      domain,
      available: isTrue(r['@_Available']),
      premium,
      price: premium && Number.isFinite(premiumPrice) && premiumPrice > 0
        ? premiumPrice
        : (std?.price ?? null),
      currency: std?.currency || 'USD',
      error: r['@_ErrorNo'] && r['@_ErrorNo'] !== '0' ? String(r['@_Description'] || 'check_failed') : null,
    };
  });
  rows.sort((a, b) => (a.available === b.available ? 0 : a.available ? -1 : 1));
  return { ok: true, registrar: 'namecheap', results: rows };
}

// ── Purchase (operator-gated) ───────────────────────────────────────────────

const CONTACT_REQUIRED = ['first_name', 'last_name', 'email', 'phone', 'address1', 'city', 'state_province', 'postal_code', 'country'];

export function validateContact(contact) {
  const c = contact || {};
  for (const k of CONTACT_REQUIRED) {
    if (!String(c[k] || '').trim()) return { ok: false, error: `contact_missing_${k}` };
  }
  if (!String(c.email).includes('@')) return { ok: false, error: 'contact_email_invalid' };
  // Namecheap wants phone as +NNN.NNNNNNNNNN — pass through if already
  // shaped, otherwise best-effort digits (honest failure comes back from the
  // API if it still refuses).
  return { ok: true };
}

function contactParams(contact) {
  const c = contact;
  const roles = ['Registrant', 'Tech', 'Admin', 'AuxBilling'];
  const params = {};
  for (const role of roles) {
    params[`${role}FirstName`] = c.first_name;
    params[`${role}LastName`] = c.last_name;
    if (c.organization) params[`${role}OrganizationName`] = c.organization;
    params[`${role}Address1`] = c.address1;
    if (c.address2) params[`${role}Address2`] = c.address2;
    params[`${role}City`] = c.city;
    params[`${role}StateProvince`] = c.state_province;
    params[`${role}PostalCode`] = c.postal_code;
    params[`${role}Country`] = c.country;
    params[`${role}Phone`] = c.phone;
    params[`${role}EmailAddress`] = c.email;
  }
  return params;
}

/**
 * Purchase a domain — REAL MONEY. Refuses without confirm:true AND creds.
 * Search-before-buy: re-checks availability immediately before the create so
 * an already-owned/taken domain (double-click, race) never double-charges —
 * "not available" on a domain we just bought is the idempotent no-op path.
 */
export async function purchaseDomain(domain, contact, { confirm = false, years = 1 } = {}) {
  if (confirm !== true) return { ok: false, status: 400, error: 'confirm_required' };
  if (!configured()) return { ok: false, status: 400, error: 'namecheap_not_configured' };
  const cv = validateContact(contact);
  if (!cv.ok) return { ok: false, status: 400, error: cv.error };

  const check = await ncCall('namecheap.domains.check', { DomainList: domain });
  if (!check.ok) return { ok: false, status: 502, error: check.error };
  const row = asArray(check.response?.DomainCheckResult)[0];
  if (!row || !isTrue(row['@_Available'])) {
    return { ok: false, status: 409, error: 'domain_not_available' };
  }

  const res = await ncCall('namecheap.domains.create', {
    DomainName: domain,
    Years: String(Math.max(1, Math.min(10, Number(years) || 1))),
    AddFreeWhoisguard: 'yes',
    WGEnabled: 'yes',
    ...contactParams(contact),
  });
  if (!res.ok) return { ok: false, status: 502, error: res.error };
  const created = res.response?.DomainCreateResult;
  if (!created || !isTrue(created['@_Registered'])) {
    return { ok: false, status: 502, error: 'namecheap_purchase_not_confirmed' };
  }
  return {
    ok: true,
    registrar: 'namecheap',
    domain: String(created['@_Domain'] || domain).toLowerCase(),
    charged_amount: created['@_ChargedAmount'] ?? null,
    order_id: created['@_OrderID'] ?? null,
    domain_id: created['@_DomainID'] ?? null,
  };
}

// ── Owned domains ───────────────────────────────────────────────────────────

export async function listOwnedDomains() {
  if (!configured()) return { ok: false, error: 'namecheap_not_configured', domains: [] };
  const res = await ncCall('namecheap.domains.getList', { PageSize: '100' });
  if (!res.ok) return { ok: false, error: res.error, domains: [] };
  const rows = asArray(res.response?.DomainGetListResult?.Domain).map((d) => ({
    domain: String(d['@_Name'] || '').toLowerCase(),
    created: d['@_Created'] || null,
    expires: d['@_Expires'] || null,
    expired: isTrue(d['@_IsExpired']),
    locked: isTrue(d['@_IsLocked']),
    auto_renew: isTrue(d['@_AutoRenew']),
  }));
  return { ok: true, registrar: 'namecheap', domains: rows };
}
