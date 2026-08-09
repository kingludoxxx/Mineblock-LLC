// RENDER smoke test for the Live View presentation components.
//
// The pure-logic harness (presentation.mjs) proves the decisions; this proves
// the components actually RENDER them — and, above all, that the page survives
// a board with ZERO events and shows an honest empty state instead of a blank
// card or a crash.
//
// It is JSX, so it cannot run under bare node. `run-render-smoke.mjs` bundles
// it with the project's OWN vite/react toolchain (SSR mode) and then runs the
// output. Effects never fire under renderToStaticMarkup, which is exactly what
// makes this safe: no canvas, no rAF, no AudioContext, no SSE.
import { renderToStaticMarkup } from 'react-dom/server';
import LiveGlobe from '../../../client/src/pages/live/LiveGlobe.jsx';
import PaymentToastStack from '../../../client/src/pages/live/PaymentToastStack.jsx';
import SaleAlertControls from '../../../client/src/pages/live/SaleAlertControls.jsx';
import EventRail from '../../../client/src/pages/live/EventRail.jsx';
import { RailCard } from '../../../client/src/pages/live/RailCards.jsx';
import { RevenueTile } from '../../../client/src/pages/live/LiveViewPage.jsx';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const has = (html, needle, m) => ok(html.includes(needle), m, `missing ${JSON.stringify(needle)}`);
const lacks = (html, needle, m) => ok(!html.includes(needle), m, `unexpectedly present: ${JSON.stringify(needle)}`);

const R = (el) => renderToStaticMarkup(el);

// ═══ 1. LiveGlobe ══════════════════════════════════════════════════════════
console.log('\n── 1. LiveGlobe ──');
{
  // ZERO EVENTS — the case the brief calls out by name.
  const empty = R(<LiveGlobe geo={null} live={0} />);
  has(empty, 'lv-globe-empty', 'null geo renders the EMPTY state, not a blank globe');
  has(empty, 'Visitor globe unavailable', 'the empty state names itself');
  lacks(empty, '<canvas', 'no canvas is mounted when there is nothing to plot');

  // A degraded read must surface the SERVER's own reason, not a generic line.
  const degraded = R(<LiveGlobe geo={{ available: false, reason: 'country breakdown could not be read this tick (see warnings)', by_country: [] }} />);
  has(degraded, 'could not be read this tick', "the server's own reason is surfaced verbatim");

  // available:true but every code unplottable ⇒ still the empty state, and the
  // off-map count is DISCLOSED rather than the card silently showing nothing.
  const offmap = R(<LiveGlobe geo={{ available: true, by_country: [{ country: 'ZZ', visitors: 9 }] }} />);
  has(offmap, 'lv-globe-empty', 'all-unplottable renders the empty state');
  has(offmap, 'no place on the map', 'off-map visitors are disclosed');
  has(offmap, 'ZZ', 'the off-map code is named');

  // The real thing.
  const live = R(<LiveGlobe geo={{
    available: true,
    by_country: [
      { country: 'US', visitors: 40 },
      { country: 'GB', visitors: 12 },
      { country: 'DE', visitors: 7 },
      { country: 'AU', visitors: 3 },
      { country: 'BR', visitors: 2 },
    ],
    coverage: { resolved_visitors: 64, total_visitors: 80, resolved_pct: 80 },
  }} live={17} />);
  has(live, 'lv-globe', 'a populated globe renders the globe card');
  has(live, '<canvas', 'the canvas is mounted');
  has(live, 'lv-globe-legend', 'the legend renders');
  has(live, 'United States', 'the biggest country is labelled');
  has(live, '17 live', 'the live count renders');
  has(live, 'lv-globe-caveat', 'the caveat renders');
  has(live, 'not a person', 'the caveat says a marker is a COUNTRY, not a person');
  has(live, '64 of 80', 'coverage is stated');
  // Legend is top-4, biggest first.
  ok(live.indexOf('United States') < live.indexOf('United Kingdom'), 'the legend is biggest-first');
  lacks(live, 'Brazil', 'the legend is capped at the top 4');

  // Malformed payloads must not throw.
  for (const g of [undefined, {}, { available: true }, { available: true, by_country: null }]) {
    let threw = null;
    try { R(<LiveGlobe geo={g} />); } catch (e) { threw = e; }
    ok(!threw, `LiveGlobe(${JSON.stringify(g)}) does not throw`, String(threw));
  }
}

// ═══ 2. PaymentToastStack ══════════════════════════════════════════════════
console.log('\n── 2. PaymentToastStack ──');
{
  ok(R(<PaymentToastStack toasts={[]} onDismiss={() => {}} />) === '',
    'ZERO toasts render ZERO dom (no invisible click-eating overlay)');
  ok(R(<PaymentToastStack toasts={null} onDismiss={() => {}} />) === '',
    'a null toast list renders nothing');

  const one = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt1', upsell: false, amount: 59, currency: 'USD', where: 'Breast Lift', page: 'Checkout', exiting: false },
  ]} />);
  has(one, 'lv-toast-payment', 'a payment toast renders');
  has(one, 'New payment', 'with its title');
  has(one, '$59.00', 'with the amount');
  has(one, 'Breast Lift', 'with the funnel');

  const upsell = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt2', upsell: true, amount: 39, currency: 'USD', where: 'Breast Lift', page: '', exiting: false },
  ]} />);
  has(upsell, 'lv-toast-upsell', 'an upsell toast is styled differently');
  has(upsell, 'Upsell accepted', 'with its own title');

  // The money-honesty rule, rendered.
  const nullAmt = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt3', upsell: false, amount: null, currency: 'USD', where: 'X', page: '', exiting: false },
  ]} />);
  has(nullAmt, 'amount not recorded', 'a NULL amount says so');
  lacks(nullAmt, '$0.00', 'a null amount is NEVER rendered as $0.00');

  const zeroAmt = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt4', upsell: false, amount: 0, currency: 'USD', where: 'X', page: '', exiting: false },
  ]} />);
  has(zeroAmt, '$0.00', 'a REAL zero still renders as $0.00');

  // N2: the away wording is a claim about the OPERATOR and is driven by the
  // `away` flag, never by the fact that a batch happened.
  const agg = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt5', aggregate: true, away: true, count: 9, upsell: false, amount: 90, unpriced: 2, currency: 'USD', exiting: false },
  ]} />);
  has(agg, '9 payments while you were away', 'an AWAY batch renders the away wording');
  has(agg, '+2 unpriced', 'and discloses the unpriced shortfall');

  const aggLive = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt5b', aggregate: true, away: false, count: 3, upsell: false, amount: 30, unpriced: 0, currency: 'USD', exiting: false },
  ]} />);
  has(aggLive, '3 payments just now', 'a batch that landed while WATCHING says "just now"');
  lacks(aggLive, 'while you were away', 'and never claims the operator was away');

  const exiting = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt6', upsell: false, amount: 10, currency: 'USD', where: '', page: '', exiting: true },
  ]} />);
  has(exiting, 'lv-toast--exiting', 'an exiting toast carries the exit class');

  // Location renders only when there IS one.
  const noLoc = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt7', upsell: false, amount: 10, currency: 'USD', where: 'F', page: 'P', countryLabel: null, exiting: false },
  ]} />);
  has(noLoc, 'F', 'the funnel renders without a location');
  const withLoc = R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'pt8', upsell: false, amount: 10, currency: 'USD', where: 'F', page: 'P', countryLabel: 'Germany', exiting: false },
  ]} />);
  has(withLoc, 'Germany', 'a location renders when the event carries one');
}

// ═══ 2b. F4 — money honesty, rendered ══════════════════════════════════════
console.log('\n── 2b. money honesty (F4) ──');
{
  const T = (over) => R(<PaymentToastStack onDismiss={() => {}} toasts={[
    { key: 'k', upsell: false, where: 'F', page: 'P', exiting: false, ...over },
  ]} />);

  // (a) mixed currencies: no total, and the reason is named.
  const mixed = T({ aggregate: true, count: 3, amount: null, currency: null,
    mixedCurrencies: true, currencies: ['USD', 'JPY', 'EUR'], unpriced: 0, priced: 3 });
  has(mixed, '3 payments', 'a mixed-currency batch still reports its COUNT');
  has(mixed, 'lv-toast-no-total', 'and renders the no-total state');
  has(mixed, 'mixed currencies', 'naming the reason');
  has(mixed, 'USD, JPY, EUR', 'and listing the currencies seen');
  lacks(mixed, '$300', 'and NEVER the fabricated cross-currency sum');
  lacks(mixed, '$0.00', 'and never $0.00 either');

  // (b) nothing priced: no total, different reason.
  const unpriced = T({ aggregate: true, count: 5, amount: null, currency: null,
    mixedCurrencies: false, currencies: [], unpriced: 5, priced: 0 });
  has(unpriced, '5 payments', 'an all-unpriced batch reports its count');
  has(unpriced, 'amounts unrecorded', 'and says the amounts were unrecorded');
  has(unpriced, '5 unpriced', 'and how many');
  lacks(unpriced, '$0.00', 'NEVER $0.00 — that would read as five free orders');

  // A real single-currency total still renders normally.
  const real = T({ aggregate: true, count: 4, amount: 175, currency: 'USD',
    mixedCurrencies: false, currencies: ['USD'], unpriced: 0, priced: 4 });
  has(real, '$175.00', 'a single-currency batch DOES show its total');
  lacks(real, 'mixed currencies', 'with no mixed-currency note');

  // (c) an amount with no currency: bare number + an explicit caption.
  const noCur = T({ amount: 59, currency: null });
  has(noCur, '59.00', 'an amount with no currency renders BARE');
  lacks(noCur, '$59.00', 'never with an assumed dollar sign');
  has(noCur, 'lv-toast-no-currency', 'and is captioned');
  has(noCur, 'currency not recorded', 'in words');

  const withCur = T({ amount: 59, currency: 'EUR' });
  has(withCur, '\u20ac59.00', 'a recorded currency renders with its symbol');
  lacks(withCur, 'currency not recorded', 'and carries no caption');

  // The rail says the same thing.
  const railNoCur = R(<RailCard ev={{ id: 'r', type: 'purchase', ts: null, value: 59, currency: null }} />);
  has(railNoCur, '59.00', 'the rail renders a currency-less amount bare');
  lacks(railNoCur, '$59.00', 'never assuming USD');
  has(railNoCur, 'lv-row-no-currency', 'and marks it');
  const railCur = R(<RailCard ev={{ id: 'r2', type: 'purchase', ts: null, value: 59, currency: 'USD' }} />);
  has(railCur, '$59.00', 'a recorded currency renders normally in the rail');
  lacks(railCur, 'no currency', 'with no marker');
}

// ═══ 2c. N1 — the revenue hero tile ════════════════════════
// NOTHING covered this tile, which is exactly how N1 shipped: dropping the USD
// default for F4 left the board's BIGGEST money figure rendering a bare
// "12,345.60" with no caption — reading as dollars while claiming nothing.
console.log('\n── 2c. revenue tile (N1) ──');
{
  const noCur = R(<RevenueTile snapshot={{ revenue_today: 12345.6 }} />);
  has(noCur, '12,345.60', 'the amount renders');
  lacks(noCur, '$12,345.60', 'NOT as dollars — no currency is on the wire for it');
  has(noCur, 'lv-tile-caption', 'and it is captioned');
  has(noCur, 'currency not recorded', 'in words');

  // Opportunistic: the caption disappears for free if the server ever sends one.
  const withCur = R(<RevenueTile snapshot={{ revenue_today: 12345.6, revenue_currency: 'USD' }} />);
  has(withCur, '$12,345.60', 'a supplied currency renders with its symbol');
  lacks(withCur, 'currency not recorded', 'and drops the caption');

  const eur = R(<RevenueTile snapshot={{ revenue_today: 99, revenue_currency: 'EUR' }} />);
  has(eur, '\u20ac99.00', 'a non-USD currency is honoured, not coerced to dollars');

  // null is not 0: an unmeasurable tile is a dash with its own caption.
  const nul = R(<RevenueTile snapshot={{ revenue_today: null }} />);
  has(nul, 'could not measure', 'a null revenue says "could not measure"');
  lacks(nul, '0.00', 'and NEVER renders as zero revenue');
  has(R(<RevenueTile snapshot={{}} />), 'could not measure', 'a missing field behaves the same');

  // A real zero is a real number.
  const zero = R(<RevenueTile snapshot={{ revenue_today: 0, revenue_currency: 'USD' }} />);
  has(zero, '$0.00', 'a genuine zero renders as $0.00');
  lacks(zero, 'could not measure', 'and is not confused with an unmeasurable tile');
}

// ═══ 3. SaleAlertControls ══════════════════════════════════════════════════
console.log('\n── 3. SaleAlertControls ──');
{
  ok(R(<SaleAlertControls sound={null} />) === '', 'no sound object renders nothing');
  ok(R(<SaleAlertControls sound={{ supported: false }} />) === '',
    'UNSUPPORTED renders NOTHING — there is no honest control to offer');

  const locked = R(<SaleAlertControls sound={{ supported: true, needsUnlock: true, volume: 0.5, muted: false }} />);
  has(locked, 'lv-sound-unlock', 'a LOCKED context offers an explicit unlock');
  has(locked, 'Enable sound', 'and says so in words');

  const on = R(<SaleAlertControls sound={{ supported: true, needsUnlock: false, muted: false, volume: 0.5 }} />);
  has(on, 'lv-alert-controls', 'the controls render');
  has(on, 'lv-sound-volume', 'the volume slider renders');
  has(on, 'value="50"', 'the slider reflects the stored volume');
  has(on, '50%', 'the level is legible');
  has(on, 'aria-pressed="true"', 'the toggle exposes its state to assistive tech');

  const muted = R(<SaleAlertControls sound={{ supported: true, needsUnlock: false, muted: true, volume: 0.8 }} />);
  has(muted, 'disabled', 'the slider is disabled while muted');
  has(muted, 'off', 'and reads "off"');
  has(muted, 'aria-pressed="false"', 'the toggle reports muted');
  has(muted, 'value="80"', 'the REMEMBERED level is still shown while muted');
}

// ═══ 4. EventRail / RailCards ══════════════════════════════════════════════
console.log('\n── 4. EventRail / RailCards ──');
{
  const empty = R(<EventRail feed={[]} connected />);
  has(empty, 'lv-rail-empty', 'ZERO events renders the empty state');
  has(empty, 'No activity yet', 'which says so plainly');
  has(empty, 'will stream in here', 'and says what will appear');

  const disconnected = R(<EventRail feed={[]} connected={false} />);
  has(disconnected, 'reconnecting', 'a disconnected empty rail explains WHY it is empty');

  ok(R(<EventRail feed={null} connected />).includes('lv-rail-empty'), 'a null feed renders the empty state');

  const rail = R(<EventRail connected feed={[
    { id: 'c_1', type: 'purchase', ts: new Date().toISOString(), funnel_name: 'Breast Lift', page_title: 'Checkout', value: 59, currency: 'USD', upsell: false },
    { id: 'c_2', type: 'purchase', ts: new Date().toISOString(), funnel_name: 'Breast Lift', value: 39, currency: 'USD', upsell: true },
    { id: 'k_1', type: 'checkout_start', ts: new Date().toISOString(), funnel_name: 'Breast Lift', value: 59, currency: 'USD' },
    { id: 't_1', type: 'view', ts: new Date().toISOString(), funnel_name: 'Breast Lift', page_slug: 'lp-1', value: null },
  ]} />);
  has(rail, 'lv-rail', 'a populated rail renders the list');
  has(rail, 'lv-event-purchase', 'purchases render');
  has(rail, 'lv-event-checkout_start', 'checkout starts render');
  has(rail, 'lv-event-view', 'pageviews render');
  has(rail, 'upsell', 'the upsell badge renders');
  has(rail, '$59.00', 'the amount renders');
  has(rail, 'just now', 'the relative timestamp renders');
  lacks(rail, 'lv-row-fresh', 'FIRST paint flashes nothing');

  // An unattributed / valueless row must degrade, not crash or print $0.00.
  const bare = R(<RailCard ev={{ id: 'x', type: 'purchase', ts: null, value: null }} />);
  has(bare, 'unattributed', 'a funnel-less event says "unattributed"');
  lacks(bare, '$0.00', 'a null value renders NO amount, never $0.00');

  const unknown = R(<RailCard ev={{ id: 'y', type: 'not_a_type', ts: null }} />);
  ok(unknown.length > 0, 'an unknown event type degrades to the default style, no crash');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.error(`\n${fail} assertion(s) failed`);
  process.exit(1);
}
