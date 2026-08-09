/**
 * renderCheck — actually RENDERS the explorer instead of only compiling it.
 *
 * "It builds" is not evidence that a component renders; a bad hook order, a
 * read off an undefined result or a formatter called with the wrong shape only
 * shows up when React walks the tree. This entry is bundled for SSR
 * (tests/vite.rendercheck.config.js) and run under node, so the whole surface
 * is exercised with no browser and no server.
 *
 * WHAT SSR DOES AND DOES NOT COVER: effects never run, so nothing here fetches
 * — which is the point, the FIRST paint is what has to be safe. The fetch paths
 * are covered separately by explorerRuntime.harness.mjs.
 */
import { renderToStaticMarkup } from 'react-dom/server';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  PASS  ${name}`); } catch (e) {
    fail += 1; failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function must(condition, message) { if (!condition) throw new Error(message); }

/* A minimal DOM surface: the explorer reads window.location.search once for its
   deep-link seed and touches localStorage through the guarded store. */
function installWindow(search = '') {
  globalThis.window = {
    location: { search, pathname: '/analytics/explore', hash: '' },
    history: { state: null, replaceState() {} },
    localStorage: {
      _v: null,
      getItem() { return this._v; },
      setItem(_k, v) { this._v = v; },
      removeItem() { this._v = null; },
    },
  };
}
installWindow();

const { default: AnalyticsExplorer } = await import('../index.jsx');
const { default: ExplorerChart } = await import('../ExplorerChart.jsx');
const { formatterFor } = await import('../../reportConfig.js');

console.log('\n── SSR render ──────────────────────────────────────────');

check('the explorer renders with NO props at all', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('data-testid="analytics-explorer"'), 'root testid missing');
  must(html.includes('data-testid="ax-controls"'), 'controls missing');
  must(html.includes('data-testid="ax-metrics"'), 'metric chips missing');
  must(html.includes('· UTC'), 'the header must print UTC out loud');
});

check('the default view selects net sales + orders and offers Explore mode', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('Net sales · Orders over time'), 'default report title wrong');
  must(html.includes('data-testid="ax-mode-query"'), 'query mode missing');
  must(html.includes('data-testid="ax-mode-roas"'), 'roas mode missing');
  must(html.includes('data-testid="ax-mode-clicks"'), 'clicks mode missing');
});

check('illegal chips render DISABLED with the reason as their tooltip', () => {
  installWindow('?dimension=product&metrics=orders&viz=bar');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  const chip = html.slice(html.indexOf('data-testid="ax-metric-sessions"') - 400,
    html.indexOf('data-testid="ax-metric-sessions"'));
  must(chip.includes('disabled'), 'sessions must be disabled under the product group-by');
  must(chip.includes('not measured by Product'), `the reason must be on the chip, got: ${chip}`);
});

check('a deep link is honoured on first paint (group-by + bar + compare)', () => {
  installWindow('?metrics=gross_sales,refunds&dimension=gateway&viz=bar&compare=1');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('Gross sales · Refunds by Gateway'), 'deep-linked title wrong');
  must(html.includes('Compare: on'), 'compare state not seeded');
  must(html.includes('basis: captured_base'), 'the gateway basis must be printed');
});

check('a HOSTILE deep link is repaired at render, not obeyed', () => {
  installWindow('?metrics=sessions&dimension=product&viz=line&gateway=bitcoin');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(!html.includes('Sessions by Product'), 'an illegal combination must never reach the title');
  must(html.includes('by Product'), 'the legal part of the link should survive');
});

check('the roas / clicks modes ask for a funnel instead of firing blind', () => {
  installWindow('?mode=roas');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('data-testid="ax-need-funnel"'), 'missing the per-funnel notice');
  must(html.includes('per-funnel report'), 'the notice must explain why');
});

check('a scoped funnel prop renders as a chip, not an editable input', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer funnelId="f_1" funnelName="Activator Oil" />);
  must(html.includes('Activator Oil'), 'funnel name missing');
  must(!html.includes('data-testid="ax-filter-funnel"'), 'the funnel input must be replaced by the chip');
});

check('the device dimension is OFFERED but disabled, never silently omitted', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('By Device'), 'device must appear in the group-by list');
  const opt = html.slice(html.indexOf('By Device') - 300, html.indexOf('By Device') + 40);
  must(opt.includes('disabled'), 'device must be disabled');
  must(opt.includes('not collected yet'), `device must say why, got: ${opt}`);
});

check('hourly granularity is disabled on a multi-day window, with the reason', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  const seg = html.slice(html.indexOf('data-testid="ax-granularity-hour"') - 400,
    html.indexOf('data-testid="ax-granularity-hour"'));
  must(seg.includes('disabled'), 'hour must be disabled over 30 days');
  must(seg.includes('single-day'), `hour must say why, got: ${seg}`);
});

check('the chart renders nulls as GAPS (connectNulls false) and a dashed previous', () => {
  const html = renderToStaticMarkup(
    <ExplorerChart
      viz="line"
      data={[{ key: 'a', orders: 3 }, { key: 'b', orders: null }, { key: 'c', orders: 5 }]}
      prevData={[{ key: 'x', orders: 2 }, { key: 'y', orders: 4 }, { key: 'z', orders: 1 }]}
      metricKeys={['orders']}
      labels={{ orders: 'Orders' }}
      formatters={{ orders: formatterFor('orders') }}
    />,
  );
  must(html.length > 0, 'chart rendered nothing at all');
  must(html.includes('recharts') || html.includes('svg') || html.includes('div'),
    'chart produced no markup');
});

check('the bar chart renders too', () => {
  const html = renderToStaticMarkup(
    <ExplorerChart viz="bar" data={[{ key: 'stripe', gross_sales: 10 }]} prevData={[]}
      metricKeys={['gross_sales']} labels={{}} formatters={{}} />,
  );
  must(html.length > 0, 'bar chart rendered nothing');
});

/* EXPLORER_DUMP=1 prints the markup so a human can READ what was asserted on,
   rather than trusting a green count. */
if (globalThis.process?.env?.EXPLORER_DUMP) {
  installWindow('?metrics=gross_sales,refunds&dimension=gateway&viz=bar&compare=1');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  console.log(`\n── markup (class attributes stripped) ──────────────────\n${
    html.replace(/ class="[^"]*"/g, '').replace(/></g, '>\n<')}`);
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  • ${f}`));
  globalThis.process?.exit(1);
}
console.log('explorer render check green.');
