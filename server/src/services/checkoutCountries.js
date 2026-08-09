// Checkout COUNTRY + shipping-mode contract — the single normalizer for the
// `settings.commerce` blob that Funnel Settings → Commerce → Shipping writes.
//
// WHERE THE DATA LIVES: funnels.settings (JSONB) under the `commerce` key,
// written by the client through the EXISTING funnels PATCH (read-merge-write,
// settingsPatch.js) — there is no second writer. This module is the READ side:
// every consumer runs the stored blob through readCommerceSettings() so a
// hand-edited or half-written blob degrades to the safe defaults instead of
// reaching a caller as garbage.
//
// SAFE DEFAULTS, stated once:
//   shipping_mode        'shopify'  (live rates; the recommended posture)
//   restrict_countries   false      (checkout open to every country)
//   allowed_countries    []         (meaningless while restrict is false)
//   flat_rates           []
// `restrict_countries: true` with an EMPTY allowed list is NOT read as "block
// everything" — it is read as a misconfiguration and degrades to unrestricted,
// because the alternative is a funnel that silently sells to nobody.
//
// ⚠️ ENFORCEMENT: nothing in this file enforces anything. It is admin config +
// its normalizer. The enforcement point is documented in the router header
// (routes/funnelCommerce.js) and is deliberately NOT wired here — the public
// checkout is a single-writer lane.

// ISO 3166-1 alpha-2, officially assigned codes only. User-assigned (XA/XB/XZ),
// exceptionally reserved (UK, EU, EZ) and aggregate pseudo-regions (QO, ZZ) are
// absent ON PURPOSE: a buyer who picks one fails at the payment processor, so
// they must not be storable as a checkout country.
const ISO_ALPHA2_LIST = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ '
  + 'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ '
  + 'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY '
  + 'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY '
  + 'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ '
  + 'NA NC NE NF NG NI NL NO NP NR NU NZ OM '
  + 'PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ '
  + 'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ '
  + 'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

export const ISO_ALPHA2 = new Set(ISO_ALPHA2_LIST);

// How many countries one funnel may list. Far above any real configuration
// (the whole world is 249) — this is a payload bound, not a policy.
export const MAX_ALLOWED_COUNTRIES = 249;
export const MAX_FLAT_RATES = 25;

export function isValidCountryCode(code) {
  return ISO_ALPHA2.has(String(code == null ? '' : code).trim().toUpperCase());
}

/**
 * Total function. Any input -> { codes, invalid }.
 *   codes    valid ISO alpha-2, upper-cased, de-duplicated, input order kept
 *   invalid  every rejected entry, VERBATIM, so a UI can name what it dropped
 * Never throws; a non-array (null, a string, an object) yields empty arrays.
 */
export function normalizeCountryCodes(input) {
  const codes = [];
  const invalid = [];
  const seen = new Set();
  if (!Array.isArray(input)) return { codes, invalid };
  for (const raw of input.slice(0, MAX_ALLOWED_COUNTRIES * 2)) {
    // Objects/arrays/null are not country codes; String(x) would turn them into
    // '[object Object]' and hide the fault, so they are rejected as-is.
    if (typeof raw !== 'string' && typeof raw !== 'number') { invalid.push(raw); continue; }
    const up = String(raw).trim().toUpperCase();
    if (!ISO_ALPHA2.has(up)) { invalid.push(raw); continue; }
    if (seen.has(up)) continue;
    seen.add(up);
    codes.push(up);
    if (codes.length >= MAX_ALLOWED_COUNTRIES) break;
  }
  return { codes, invalid };
}

/**
 * jsonb columns arrive as an OBJECT from postgres.js, but a value that was
 * ever double-encoded (or hand-inserted as text) arrives as a STRING. Both
 * shapes must read the same — this is the fourth time that trap has bitten
 * this codebase, so the read side handles both and NEVER throws.
 * Mirrors routes/briefPipeline.js `parseJsonb`.
 */
export function parseJsonColumn(val, fallback = null) {
  if (val == null) return fallback;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return parsed == null ? fallback : parsed;
    } catch { return fallback; }
  }
  return val;
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

const SHIPPING_MODES = new Set(['shopify', 'manual']);

/**
 * Total function. funnels.settings (object OR json string OR junk) ->
 *   { shipping_mode, restrict_countries, allowed_countries, flat_rates }
 * Unknown modes fall back to 'shopify'; see the header for why an empty
 * allow-list cannot mean "block the world".
 */
export function readCommerceSettings(settings) {
  const root = parseJsonColumn(settings, {});
  const commerce = isObj(root) && isObj(root.commerce) ? root.commerce : {};

  const mode = SHIPPING_MODES.has(commerce.shipping_mode) ? commerce.shipping_mode : 'shopify';
  const { codes } = normalizeCountryCodes(commerce.allowed_countries);
  // A restriction with nothing to allow is a misconfiguration, not a ban.
  const restrict = commerce.restrict_countries === true && codes.length > 0;

  const flat = [];
  if (Array.isArray(commerce.flat_rates)) {
    for (const r of commerce.flat_rates.slice(0, MAX_FLAT_RATES)) {
      if (!isObj(r)) continue;
      const cost = Number(r.cost);
      flat.push({
        id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `rate_${flat.length + 1}`,
        label: typeof r.label === 'string' ? r.label.slice(0, 120) : '',
        description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
        // NaN/Infinity/negative are not money. 0 is legitimate (free shipping).
        cost: Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 100) / 100 : 0,
        default: r.default === true,
      });
    }
  }

  return {
    shipping_mode: mode,
    restrict_countries: restrict,
    // Returned even when restrict is false: the operator's picked set is still
    // their saved draft, and the UI must render it after a reload.
    allowed_countries: codes,
    flat_rates: flat,
  };
}

export default {
  ISO_ALPHA2,
  isValidCountryCode,
  normalizeCountryCodes,
  parseJsonColumn,
  readCommerceSettings,
};
