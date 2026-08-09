/**
 * renderCheck — RENDERS the explorer instead of only compiling it.
 *
 * The previous version rendered the CONTROLS and nothing else: with no network
 * under SSR there is never a result, so the whole data-rendering region — the
 * four tables, the delta chips, the click-time column — shipped green while
 * every defect in it survived. That is why ResultTables.jsx exists as its own
 * module: the tables are rendered here DIRECTLY, against fixtures shaped from
 * the real Lane 1 / Lane 2 response builders (tests/fixtures.mjs).
 *
 * Bundled for SSR (tests/vite.rendercheck.config.js) and run under node:
 *   npx vite build --config src/pages/analytics/explorer/tests/vite.rendercheck.config.js
 *   node dist/explorer-render/renderCheck.js
 *   EXPLORER_DUMP=1 node dist/explorer-render/renderCheck.js   # print markup
 *
 * WHAT SSR COVERS AND DOES NOT: effects never run, so nothing fetches — which
 * is the point for the controls (the FIRST paint has to be safe). The fetch and
 * reader paths are covered by explorerRuntime.harness.mjs.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { CLICKS, QUERY_ROWS, QUERY_SERIES, ROAS } from './fixtures.mjs';

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
/** The markup with class attributes stripped — what the assertions read. */
const plain = (html) => html.replace(/ class="[^"]*"/g, '');

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
const { BigNumbers, ClicksTable, QueryTable, RoasTable } = await import('../ResultTables.jsx');
const { formatterFor, readQueryResult, readRoasResult, readClicksResult } = {
  ...(await import('../../reportConfig.js')),
  ...(await import('../explorerApi.js')),
};

/* ══ 1. the controls ═════════════════════════════════════════════════ */
console.log('\n── 1. controls (SSR) ───────────────────────────────────');

check('the explorer renders with NO props at all', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('data-testid="analytics-explorer"'), 'root testid missing');
  must(html.includes('data-testid="ax-controls"'), 'controls missing');
  must(html.includes('data-testid="ax-metrics"'), 'metric chips missing');
});

check('the header names the REPORT zone, not a hardcoded UTC', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('Madrid time'), 'the reporting zone must be named on the header');
  must(!html.includes('· UTC'), 'UTC must not be printed when the report zone is Madrid');
  must(html.includes('window not yet confirmed by the server'),
    'before a response, the header must not claim the window is the server’s');
});

check('the default view selects net sales + orders and offers all three modes', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('Net sales · Orders over time'), 'default report title wrong');
  ['query', 'roas', 'clicks'].forEach((m) => must(html.includes(`data-testid="ax-mode-${m}"`), `${m} mode missing`));
});

check('illegal chips render DISABLED with the reason as their tooltip', () => {
  installWindow('?dimension=gateway&metrics=orders&viz=bar');
  const html = plain(renderToStaticMarkup(<AnalyticsExplorer />));
  const at = html.indexOf('data-testid="ax-metric-spend"');
  must(at > 0, 'the spend chip is missing');
  const chip = html.slice(at - 300, at);
  must(chip.includes('disabled'), 'spend must be disabled under the gateway group-by');
  must(chip.includes('not measured by Gateway'), `the reason must be on the chip, got: ${chip}`);
});

check('SPEND is offered on funnel and refused everywhere else (engine matrix)', () => {
  installWindow('?dimension=funnel&metrics=orders&viz=bar');
  const funnelHtml = plain(renderToStaticMarkup(<AnalyticsExplorer />));
  const at = funnelHtml.indexOf('data-testid="ax-metric-spend"');
  must(!funnelHtml.slice(at - 300, at).includes('disabled'), 'spend must be selectable on funnel');
});

check('a deep link is honoured on first paint (group-by + bar + compare)', () => {
  installWindow('?metrics=gross_sales,refunds&dimension=gateway&viz=bar&compare=1');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('Gross sales · Refunds by Gateway'), 'deep-linked title wrong');
  must(html.includes('Compare: on'), 'compare state not seeded');
  must(!html.includes('basis: captured_base'),
    'the client must NOT print its own basis — only meta.basis_label from the response');
});

check('a HOSTILE deep link is repaired, never obeyed', () => {
  installWindow('?metrics=spend&dimension=gateway&viz=line&gateway=bitcoin');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(!html.includes('Ad spend by Gateway'), 'an illegal combination must never reach the title');
  must(html.includes('by Gateway'), 'the legal part of the link should survive');
});

check('an INVALID state is blocked with prose instead of a fetch', () => {
  installWindow('?start_day=2024-01-01&end_day=2026-08-08');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('data-testid="ax-invalid"'), 'an over-long window must be refused on screen');
  must(/caps a query at 400/.test(html), 'the refusal must say what the cap is');
});

check('the roas / clicks modes ask for a funnel instead of firing blind', () => {
  installWindow('?mode=roas');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(html.includes('data-testid="ax-need-funnel"'), 'missing the per-funnel notice');
  must(html.includes('per-funnel report'), 'the notice must explain why');
});

check('roas mode says the picker sets a LENGTH, not a range', () => {
  installWindow('?mode=roas&funnel_id=f_1');
  const html = renderToStaticMarkup(<AnalyticsExplorer />);
  must(/picker sets the LENGTH/.test(html),
    'the picker/endpoint mismatch must be stated, not silently contradicted');
});

check('a scoped funnel prop renders as a chip, not an editable input', () => {
  installWindow();
  const html = renderToStaticMarkup(<AnalyticsExplorer funnelId="f_1" funnelName="Activator Oil" />);
  must(html.includes('Activator Oil'), 'funnel name missing');
  must(!html.includes('data-testid="ax-filter-funnel"'), 'the funnel input must be replaced by the chip');
});

check('the device dimension is OFFERED but disabled, never silently omitted', () => {
  installWindow();
  const html = plain(renderToStaticMarkup(<AnalyticsExplorer />));
  const at = html.indexOf('By Device');
  must(at > 0, 'device must appear in the group-by list');
  const opt = html.slice(at - 300, at + 40);
  must(opt.includes('disabled'), 'device must be disabled');
  must(opt.includes('user-agent class'), `device must say why, got: ${opt}`);
});

check('hourly granularity is disabled on a multi-day window, with the reason', () => {
  installWindow();
  const html = plain(renderToStaticMarkup(<AnalyticsExplorer />));
  const at = html.indexOf('data-testid="ax-granularity-hour"');
  must(at > 0, 'the hour segment is missing');
  const seg = html.slice(at - 300, at);
  must(seg.includes('disabled'), 'hour must be disabled over 30 days');
  must(seg.includes('single-day'), `hour must say why, got: ${seg}`);
});

/* ══ 2. the data region (the part SSR never used to reach) ═══════════ */
console.log('\n── 2. data rendering (real fixtures) ───────────────────');

const Q_SERIES = readQueryResult(QUERY_SERIES);
const Q_ROWS = readQueryResult(QUERY_ROWS);
const R = readRoasResult(ROAS);
const C = readClicksResult(CLICKS);

check('QueryTable renders a breakdown, its totals and the SERVER basis label', () => {
  const html = plain(renderToStaticMarkup(
    <QueryTable
      rows={Q_ROWS.rows} metrics={['orders', 'net_sales', 'aov']} headLabel="Gateway"
      totals={Q_ROWS.totals} basisLabel={Q_ROWS.basisLabel} limit={50} grouped
    />,
  ));
  must(html.includes('stripe') && html.includes('paypal'), 'rows missing');
  must(html.includes('$2,100.40'), `stripe net_sales not formatted: ${html.slice(0, 400)}`);
  must(html.includes('$3,304.40'), 'the totals row is missing');
  must(html.includes('captured base only'), 'the server basis label must be rendered verbatim');
});

check('a ratio with no denominator renders an EM DASH, never 0', () => {
  const html = plain(renderToStaticMarkup(
    <QueryTable rows={Q_ROWS.rows} metrics={['orders', 'aov']} headLabel="Gateway"
      totals={Q_ROWS.totals} basisLabel="" limit={50} grouped />,
  ));
  // The "(none)" row has 0 orders, so aov is null on the wire.
  const row = html.slice(html.indexOf('(none)'), html.indexOf('(none)') + 260);
  must(row.includes('—'), `a null AOV must render as an em dash, got: ${row}`);
  must(!/\$0\.00/.test(row), 'a null AOV must NOT render as $0.00');
});

check('a truncated breakdown says so instead of implying completeness', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, orders: 5 - i }));
  const html = renderToStaticMarkup(
    <QueryTable rows={rows} metrics={['orders']} headLabel="Funnel" totals={{ orders: 15 }}
      basisLabel="" limit={5} grouped />,
  );
  must(/top 5 by Orders/.test(html), 'a cut list must name the cut');
  must(/may hold more rows/.test(html), 'and must not imply the list is complete');
});

check('a funnel row is IDENTIFIED by key and READ by label (they differ)', () => {
  // funnelMetrics attachFunnelNames(): key stays the id, label upgrades to the
  // funnel NAME. Rendering the key would put a uuid on the operator's screen.
  const rows = [{ key: 'f_9a3c', label: 'Activator Oil — EU', name: 'Activator Oil — EU', orders: 12 }];
  const html = renderToStaticMarkup(
    <QueryTable rows={rows} metrics={['orders']} headLabel="Funnel" totals={{}} basisLabel="" limit={50} grouped />,
  );
  must(html.includes('Activator Oil — EU'), 'the label (name) must be what is drawn');
  must(!html.includes('f_9a3c'), 'the key (id) must not leak into the cell');
});

check('BigNumbers draws a delta only against a real baseline', () => {
  const html = plain(renderToStaticMarkup(
    <BigNumbers metrics={['gross_sales', 'orders']} totals={Q_SERIES.totals}
      prevTotals={Q_SERIES.prevTotals} hasPrevious={Q_SERIES.hasPrevious} compare />,
  ));
  must(html.includes('$3,722.75'), 'the current total is missing');
  must(/10\.8% vs previous/.test(html), `the gross_sales delta is wrong: ${html}`);
});

check('NO delta chip without a baseline — "no baseline", never 0%', () => {
  const noPrev = plain(renderToStaticMarkup(
    <BigNumbers metrics={['orders']} totals={{ orders: 53 }} prevTotals={{}} hasPrevious={false} compare />,
  ));
  must(noPrev.includes('no baseline'), 'a missing baseline must be named');
  must(!/0(\.0)?% vs previous/.test(noPrev), 'a fabricated 0% must never appear');
  const zeroPrev = plain(renderToStaticMarkup(
    <BigNumbers metrics={['orders']} totals={{ orders: 53 }} prevTotals={{ orders: 0 }} hasPrevious compare />,
  ));
  must(zeroPrev.includes('no baseline'), 'a previous of ZERO has no percentage either');
});

check('RoasTable renders every cost branch and dashes the unknown ones', () => {
  const html = plain(renderToStaticMarkup(<RoasTable result={R} dimension="network" />));
  must(html.includes('meta_api') && html.includes('pin_manual'), 'cost_source is a field and must be shown');
  must(html.includes('no_signal') && html.includes('api_by_campaign_only'),
    'cost_unknown_reason must be visible — it is WHY the cost cell is blank');
  const direct = html.slice(html.indexOf('direct / none'), html.indexOf('direct / none') + 700);
  must(!/\$0\.00/.test(direct.split('unknown')[0]), 'an unknown cost must not render as $0.00');
  must(!/0\.00×/.test(direct), 'an unknown ROAS must not render as 0.00×');
  must(direct.includes('—'), 'an unknown cost/cpa/roas must render as em dashes');
});

check('RoasTable surfaces bot clicks and a real "Top N of M" footer', () => {
  const html = plain(renderToStaticMarkup(<RoasTable result={R} dimension="network" />));
  must(/311 bot/.test(html), 'bot_clicks must be surfaced beside the click count');
  must(/Top 4 of 9/.test(html), `the footer must use the SERVER row count, got: ${html.slice(-500)}`);
  must(/\$10,831\.25/.test(html), 'the footer must fold the whole-window revenue');
  must(/list truncated/.test(html), 'row_cap must be stated');
});

check('ClicksTable reads `time` (Lane 2\'s field) in the REPORT zone', () => {
  const html = plain(renderToStaticMarkup(<ClicksTable result={C} timezone="Europe/Madrid" />));
  // 2026-08-09T21:30Z is 23:30 Madrid.
  must(html.includes('2026-08-09 23:30'), `the first click time is wrong: ${html.slice(0, 900)}`);
  // 2026-08-09T23:30Z is 01:30 on the 10th Madrid — a UTC formatter dates this
  // one day early, which is the whole reason Lane 2 keys days in the zone.
  must(html.includes('2026-08-10 01:30'), 'a late-evening UTC click must roll to the next Madrid day');
});

check('ClicksTable falls back to `day` when there is no instant', () => {
  const html = plain(renderToStaticMarkup(<ClicksTable result={C} timezone="Europe/Madrid" />));
  must(html.includes('2026-08-08'), 'a row with time=null must still show its reported day');
});

check('ClicksTable flags bots and velocity, and folds per-network counts', () => {
  const html = plain(renderToStaticMarkup(<ClicksTable result={C} timezone="Europe/Madrid" />));
  must(html.includes('>bot<'), 'a bot click must be flagged');
  must(html.includes('>velocity<'), 'a velocity-flagged click must be flagged');
  must(/meta: 1 clicks · 1 conv/.test(html), `the per-network fold is missing: ${html.slice(0, 500)}`);
  must(/tiktok: 1 clicks · 0 conv · 1 bot/.test(html), 'the bot count per network is missing');
});

check('a truncated click ledger says so', () => {
  const html = renderToStaticMarkup(
    <ClicksTable result={{ ...C, truncated: true, limit: 200 }} timezone="UTC" />,
  );
  must(html.includes('data-testid="ax-clicks-truncated"'), 'truncated must be surfaced');
  must(/the ledger holds more/.test(html), 'and must say what it means');
});

check('every table survives an EMPTY result without throwing', () => {
  renderToStaticMarkup(<QueryTable rows={[]} metrics={[]} headLabel="Day" totals={{}} basisLabel="" limit={50} />);
  renderToStaticMarkup(<RoasTable result={{ rows: [], totals: null, rowsTotal: 0 }} dimension="network" />);
  renderToStaticMarkup(<ClicksTable result={{ rows: [], byNetwork: {} }} timezone="UTC" />);
  renderToStaticMarkup(<BigNumbers metrics={[]} totals={{}} prevTotals={{}} hasPrevious={false} compare={false} />);
});

check('every table survives an UNDEFINED result without throwing', () => {
  // The mode-switch race this guards: a clicks renderer handed a query payload.
  renderToStaticMarkup(<RoasTable result={undefined} dimension="network" />);
  renderToStaticMarkup(<ClicksTable result={undefined} timezone="UTC" />);
  renderToStaticMarkup(<QueryTable rows={undefined} metrics={undefined} headLabel="Day" totals={undefined} />);
  renderToStaticMarkup(<BigNumbers metrics={undefined} totals={undefined} prevTotals={undefined} />);
});

/* ══ 3. the chart ════════════════════════════════════════════════════ */
console.log('\n── 3. chart ────────────────────────────────────────────');

check('the line chart renders a series with a null gap and a compare overlay', () => {
  const html = renderToStaticMarkup(
    <ExplorerChart
      viz="line"
      data={Q_SERIES.series}
      prevData={Q_SERIES.prevSeries}
      metricKeys={['gross_sales', 'orders']}
      labels={{ gross_sales: 'Gross sales', orders: 'Orders' }}
      formatters={{ gross_sales: formatterFor('gross_sales'), orders: formatterFor('orders') }}
    />,
  );
  must(html.length > 0, 'chart rendered nothing at all');
});

check('the bar chart renders a breakdown', () => {
  const html = renderToStaticMarkup(
    <ExplorerChart viz="bar" data={Q_ROWS.rows} prevData={[]}
      metricKeys={['net_sales']} labels={{ net_sales: 'Net sales' }}
      formatters={{ net_sales: formatterFor('net_sales') }} />,
  );
  must(html.length > 0, 'bar chart rendered nothing');
});

check('the chart survives empty / mismatched inputs', () => {
  renderToStaticMarkup(<ExplorerChart viz="line" data={[]} prevData={[]} metricKeys={[]} />);
  renderToStaticMarkup(<ExplorerChart viz="bar" data={undefined} prevData={undefined} metricKeys={undefined} />);
  // prevData SHORTER than data — index alignment must not read past the end.
  renderToStaticMarkup(
    <ExplorerChart viz="line" data={Q_SERIES.series} prevData={[{ key: 'x', gross_sales: 1 }]}
      metricKeys={['gross_sales']} labels={{}} formatters={{}} />,
  );
});

/* ── optional markup dump ─────────────────────────────────────────── */
if (globalThis.process?.env?.EXPLORER_DUMP) {
  installWindow('?metrics=gross_sales,refunds&dimension=gateway&viz=bar&compare=1');
  console.log(`\n── controls markup ─────────────────────────────────────\n${
    plain(renderToStaticMarkup(<AnalyticsExplorer />)).replace(/></g, '>\n<')}`);
  console.log(`\n── roas table markup ───────────────────────────────────\n${
    plain(renderToStaticMarkup(<RoasTable result={R} dimension="network" />)).replace(/></g, '>\n<')}`);
  console.log(`\n── clicks table markup ─────────────────────────────────\n${
    plain(renderToStaticMarkup(<ClicksTable result={C} timezone="Europe/Madrid" />)).replace(/></g, '>\n<')}`);
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  • ${f}`));
  globalThis.process?.exit(1);
}
console.log('explorer render check green.');
