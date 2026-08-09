// CHECKOUT-COUNTRIES GATE — pure-logic verification of blockedCountryOf
// (routes/checkoutPublic.js). Policy fails closed, unknowns pass, and a
// misconfigured restriction (empty allow-list) can never block the world.
import { blockedCountryOf } from '../../src/routes/checkoutPublic.js';

let pass = 0, fail = 0;
const eq = (got, want, name) => {
  if (Object.is(got, want)) { pass += 1; }
  else { fail += 1; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const RESTRICT_US = { commerce: { restrict_countries: true, allowed_countries: ['US'] } };
const RESTRICT_US_CA = { commerce: { restrict_countries: true, allowed_countries: ['US', 'CA'] } };

// Allowed / blocked basics
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: 'US' } }), null, 'allowed country passes');
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: 'DE' } }), 'DE', 'excluded country blocked');
eq(blockedCountryOf(RESTRICT_US_CA, { shipping: { country: 'CA' } }), null, 'second allowed country passes');
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: 'de' } }), 'DE', 'case-insensitive');
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: ' de ' } }), 'DE', 'trimmed');

// Billing fallback when shipping absent; shipping wins when both present
eq(blockedCountryOf(RESTRICT_US, { billing: { country: 'FR' } }), 'FR', 'billing fallback blocked');
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: 'US' }, billing: { country: 'FR' } }), null, 'shipping wins over billing');

// Unknowns pass (we cannot block what we cannot identify)
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: 'United States' } }), null, 'free-text name passes');
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: '' } }), null, 'empty country passes');
eq(blockedCountryOf(RESTRICT_US, {}), null, 'no address passes');
eq(blockedCountryOf(RESTRICT_US, null), null, 'null customer passes');
eq(blockedCountryOf(RESTRICT_US, { shipping: { country: 'ZZ' } }), null, 'non-ISO junk code passes');

// Restriction off / misconfigured → never blocks
eq(blockedCountryOf({}, { shipping: { country: 'DE' } }), null, 'no settings never blocks');
eq(blockedCountryOf(null, { shipping: { country: 'DE' } }), null, 'null settings never blocks');
eq(blockedCountryOf({ commerce: { restrict_countries: true, allowed_countries: [] } },
  { shipping: { country: 'DE' } }), null, 'restrict with empty list degrades to unrestricted');
eq(blockedCountryOf({ commerce: { restrict_countries: false, allowed_countries: ['US'] } },
  { shipping: { country: 'DE' } }), null, 'restrict off never blocks');

// jsonb string-shape settings (double-encoded column)
eq(blockedCountryOf(JSON.stringify(RESTRICT_US), { shipping: { country: 'DE' } }), 'DE', 'string-shape settings enforced');
eq(blockedCountryOf('not json', { shipping: { country: 'DE' } }), null, 'garbage settings fail open');

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
