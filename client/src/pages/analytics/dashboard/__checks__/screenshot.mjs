// SEEDED RENDER verification — boots vite against ./harness.html, drives it
// with headless chromium, asserts the honesty rules IN THE RENDERED DOM, and
// writes screenshots for inspection (NEW FILE, LANE 3, verification only).
//
// The formatter harness proves the FUNCTIONS are honest. This proves the PAGE
// is: that no card, no table cell and no tooltip re-implements a formatter, and
// that the withheld payload produces a full, readable page with not one
// fabricated number on it.
//
// Run:  node client/src/pages/analytics/dashboard/__checks__/screenshot.mjs
// Out:  client/src/pages/analytics/dashboard/__checks__/out/*.png (gitignored)
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '../../../../..');
const OUT = resolve(HERE, 'out');
const PAGE = '/src/pages/analytics/dashboard/__checks__/harness.html';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); }
};

mkdirSync(OUT, { recursive: true });

const server = await createServer({
  root: CLIENT_ROOT,
  configFile: resolve(CLIENT_ROOT, 'vite.config.js'),
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
});
await server.listen();
const base = `http://127.0.0.1:5199`;
console.log(`\n== seeded render check == ${base}${PAGE} ==\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const notFound = [];
// THE ONE EXPECTED NETWORK FAILURE is Lane 4's module: state 6 exists to make
// that request fail. Chromium logs it as a bare "Failed to load resource: 404"
// with no URL in the message, so the URL is captured from the response event
// and asserted separately — filtering the console line alone would also have
// hidden a 404 on something that matters.
const EXPECTED_404 = 'explorer/index.jsx';
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource.*404/.test(t)) return; // asserted via notFound
  consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(`${base}${PAGE}`, { waitUntil: 'networkidle' });
await page.waitForSelector('#state-seeded [data-testid="an-funnel-performance-table"]', { timeout: 20000 });
// Recharts sizes off a ResizeObserver tick; give the charts one frame to paint.
await page.waitForTimeout(900);

/* ── 1. the page rendered at all ─────────────────────────────────────────── */

const sections = await page.$$eval('section[id^="state-"]', (els) => els.map((e) => e.id));
ok(sections.length === 6, `1 six render states mounted (${sections.join(', ')})`);
const dashCount = await page.$$eval('[data-testid="an-dashboard-page"]', (e) => e.length);
ok(dashCount === 5, `1 five DashboardView instances (${dashCount})`);

/* ── 2. the provenance line names the SERVER'S zone ──────────────────────── */

const prov = await page.$eval('#state-seeded [data-testid="an-dash-provenance"]', (e) => e.textContent.trim());
ok(prov.includes('Madrid time'), `2 provenance prints "Madrid time" (${prov})`);
ok(prov.includes('Compared to'), '2 provenance names the compare window');
ok(/Jul 11.*Aug 9, 2026/.test(prov), `2 provenance prints the window (${prov})`);
ok(prov.includes('All funnels'), '2 provenance names the scope');
ok(prov.includes('7 funnels'), `2 provenance prints the FOLDED funnel count, not the row count (${prov})`);
ok(!prov.includes('undefined') && !prov.includes('NaN'), '2 provenance has no undefined/NaN clause');

/* ── 3. the seeded window's withheld cells ───────────────────────────────── */

const DASH = '—';
const rowCells = async (fid) => page.$$eval(
  `#state-seeded [data-testid="an-funnel-row-${fid}"] td`,
  (tds) => tds.map((t) => t.textContent.trim()),
);

// Sessions · Conv · $/session withheld on the pre-TTL funnel; Orders, Gross,
// Net and Refunds still printed. Column order:
// 0 Funnel 1 Sessions 2 Orders 3 Conv 4 Gross 5 Net 6 AOV 7 $/session
// 8 Refunds 9 COGS 10 Fees 11 GP 12 GP% 13 Coverage 14 Spend 15 Net profit
// 16 ROAS 17 CPA
const legacy = await rowCells('f_legacy');
ok(legacy[1] === DASH, `3 no visitor spine -> Sessions is an em dash (${legacy[1]})`);
ok(legacy[3] === DASH, `3 no visitor spine -> Conv is an em dash (${legacy[3]})`);
ok(legacy[7] === DASH, `3 no visitor spine -> $/session is an em dash (${legacy[7]})`);
ok(legacy[2] === '141', `3 …but Orders still prints (${legacy[2]})`);
ok(legacy[4] === '$21,448.20', `3 …and Gross still prints (${legacy[4]})`);

const bundle = await rowCells('f_bundle');
ok(bundle[9] === DASH, `3 zero cost coverage -> COGS is an em dash (${bundle[9]})`);
ok(bundle[11] === DASH, `3 zero cost coverage -> GP is an em dash, NOT net sales (${bundle[11]})`);
ok(bundle[12] === DASH, `3 zero cost coverage -> GP% is an em dash, NOT 100% (${bundle[12]})`);
ok(bundle[15] === DASH, `3 zero cost coverage -> Net profit is an em dash (${bundle[15]})`);
ok(bundle[5] === '$8,240.00', `3 …but Net sales still prints (${bundle[5]})`);

const organic = await rowCells('f_organic');
ok(organic[14] === DASH, `3 no bound spend -> Spend is an em dash (${organic[14]})`);
ok(organic[16] === DASH, `3 no bound spend -> ROAS is an em dash, NOT 0.00x (${organic[16]})`);
ok(organic[17] === DASH, `3 no bound spend -> CPA is an em dash (${organic[17]})`);
ok(organic[15] === DASH, `3 no bound spend -> Net profit is an em dash (${organic[15]})`);
ok(organic[11] === '$2,811.82', `3 …but GP still prints — its costs ARE known (${organic[11]})`);

// A measured zero is still a zero.
const lift = await rowCells('f_lift');
ok(lift[13].includes('100%'), `3 full coverage prints 100% (${lift[13]})`);
ok((await rowCells('f_bundle'))[8] === '$0.00', '3 a MEASURED zero refund prints $0.00, not an em dash');

/* ── 4. the holes are admitted in words ──────────────────────────────────── */

// The seed's two unmeasured days are days with NO VISITOR SPINE — money was
// measured on them, sessions were not. So the money chart correctly has no
// holes, and the two charts built over sessions correctly do. Asserting the
// hole on the sales chart would have been asserting the wrong measurement.
const salesCaption = await page.$eval('#state-seeded [data-testid="an-card-sales-over-time-caption"]', (e) => e.textContent.trim());
ok(!salesCaption.includes('not measured'),
  `4 the MONEY chart claims no holes — its days were all measured (${salesCaption})`);
ok(salesCaption.includes('vs Jun 11 – Jul 10, 2026'),
  `4 the caption names the compare window in the page's own date vocabulary (${salesCaption})`);

const sessCaption = await page.$eval('#state-seeded [data-testid="an-card-sessions-over-time-caption"]', (e) => e.textContent.trim());
ok(sessCaption.includes('2 days not measured'), `4 the SESSIONS chart admits its 2 holes (${sessCaption})`);
const convCaption = await page.$eval('#state-seeded [data-testid="an-card-conversion-over-time-caption"]', (e) => e.textContent.trim());
ok(convCaption.includes('2 days not measured'),
  `4 the CONVERSION chart admits the same 2 holes — a rate over an unmeasured denominator is a hole (${convCaption})`);

/* ── 5. the truncations and the bases ────────────────────────────────────── */

const mkFooter = await page.$eval('#state-seeded [data-testid="an-card-marketing-footer"]', (e) => e.textContent.trim());
ok(mkFooter.includes('Top 7 of 34'), `5 the marketing card admits the tail (${mkFooter})`);
ok(mkFooter.includes('$261,212.15'), `5 …and prints the FOLDED period total (${mkFooter})`);

const mkText = await page.$eval('#state-seeded [data-testid="an-card-marketing"]', (e) => e.textContent);
ok(mkText.includes('No campaign on the click'), '5 the blank campaign bucket is labelled honestly, not dropped');
ok(mkText.includes('Captured base only'), '5 the captured-base disclaimer is printed from the server label');

const srcText = await page.$eval('#state-seeded [data-testid="an-card-sources"]', (e) => e.textContent);
ok(srcText.includes('direct / none'), '5 the blank UTM source bucket is labelled honestly');
ok(srcText.includes('Captured base only'), '5 the source card names its basis');

/* ── 6. the order value & upsells footnotes ──────────────────────────────── */

const ov = await page.$eval('#state-seeded [data-testid="an-card-order-value"]', (e) => e.textContent);
ok(ov.includes('AOV post-upsell') && ov.includes('AOV pre-upsell'), '6 both AOV bases are on the card');
ok(ov.includes('$134.49') && ov.includes('$111.02'), '6 both AOV figures render');
ok(ov.includes('31.4% take rate'), `6 the take-rate footnote prints`);
ok(ov.includes('net of $2,914.60 reversed on the legs'), '6 …with the reversal netted off the legs');
ok(ov.includes('Orders are base orders — upsell reversals are netted off Upsell revenue'),
  '6 the base-orders footnote prints');
ok(ov.includes('391 abandoned'), '6 the abandoned footnote prints');
ok(ov.includes('3,042 items sold'), '6 the items-sold footnote prints');

/* ── 7. the not-collected placeholders ───────────────────────────────────── */

const dev = await page.$eval('#state-seeded [data-testid="an-card-device-not-collected"]', (e) => e.textContent);
ok(dev.includes('Not collected'), '7 the device card says NOT COLLECTED');
ok(dev.includes('absence of measurement'), '7 …and says an absence is not a zero');
const geo = await page.$eval('#state-seeded [data-testid="an-card-geo-not-collected"]', (e) => e.textContent);
ok(geo.includes('Not collected'), '7 the geo pageview card says NOT COLLECTED');
const salesByCountry = await page.$eval('#state-seeded [data-testid="an-card-sales-by-country"] h3', (e) => e.textContent.trim());
ok(salesByCountry === 'Sales by country', `7 the country money card is "Sales by country", never "Pageviews by country" (${salesByCountry})`);

/* ── 8. THE WITHHELD PAGE INVENTS NOTHING ────────────────────────────────── */

// SCOPED TO THE PAGE, not to the band. The band's own caption names the
// forbidden strings in order to describe the test, and matching against that
// would have made the harness fail on its own prose.
const withheldText = await page.$eval('#state-withheld [data-testid="an-dashboard-page"]', (e) => e.innerText);
for (const forbidden of ['$0.00', '0.00%', '0.00x', '$0K', '0.0%']) {
  ok(!withheldText.includes(forbidden),
    `8 the withheld page prints no "${forbidden}"`,
    withheldText.split('\n').filter((l) => l.includes(forbidden)).slice(0, 3).join(' | '));
}
// Every numeric cell on that page is either an em dash or a non-figure.
const badCells = await page.$$eval('#state-withheld [data-testid="an-dashboard-page"] .tabular-nums', (els) => els
  .map((e) => e.textContent.trim())
  .filter((t) => /^[-−]?\$?0(\.0+)?%?x?$/.test(t)));
ok(badCells.length === 0, `8 no zero-valued numeric cell on the withheld page (${badCells.join(', ')})`);
ok(withheldText.includes('Madrid time'), '8 the withheld page still names the reporting zone');
ok(withheldText.includes('90-day tracking retention'), '8 …and says WHY sessions are withheld');
ok(withheldText.includes('last successful load'), '8 …and says the refresh failed over cached figures');
const withheldDashes = (withheldText.match(/—/g) || []).length;
ok(withheldDashes > 40, `8 the withheld page is full of em dashes (${withheldDashes})`);

/* ── 9. loading is not the empty state and not the dead state ────────────── */

const skeletons = await page.$$eval('#state-loading [data-testid="an-kpi-skeleton"], #state-loading [data-testid="an-card-skeleton"]', (e) => e.length);
ok(skeletons >= 8, `9 the loading page renders skeletons (${skeletons})`);
const loadingText = await page.$eval('#state-loading', (e) => e.innerText);
ok(loadingText.includes('loading…'), '9 the loading tiles say so in words');
ok(!loadingText.includes('No data for this date range'),
  '9 loading NEVER shows the empty state — that would assert a measurement');

/* ── 9b. a COLD failure says so ──────────────────────────────────────────── */

const failedText = await page.$eval('#state-failed [data-testid="an-dashboard-page"]', (e) => e.innerText);
ok(failedText.includes('Could not load the analytics dashboard'),
  '9b a cold failure NAMES the failure instead of failing silently into em dashes');
ok(!failedText.includes('last successful load'),
  '9b …and does NOT claim there are cached figures behind it');
const failedTiles = await page.$$eval('#state-failed [data-testid="an-kpi-row"] [data-testid="an-kpi-delta"]', (e) => e.length);
ok(failedTiles === 0, `9b a failed load shows NO delta chips (${failedTiles})`);

/* ── 9c. a MALFORMED payload renders, it does not throw ──────────────────── */

const hostileExists = await page.$('#state-hostile [data-testid="an-dashboard-page"]');
ok(!!hostileExists, '9c the malformed payload still renders a page (no thrown render)');
const hostileTable = await page.$('#state-hostile [data-testid="an-funnel-performance"]');
ok(!!hostileTable, '9c …including the funnel table, in its empty state');
const hostileWarn = await page.$eval('#state-hostile [data-testid="an-dash-warnings"]', (e) => e.innerText.trim());
ok(hostileWarn === 'one real warning',
  `9c a warnings array of mixed junk yields only the real string (${JSON.stringify(hostileWarn)})`);

/* ── 9d. THE EXPLORER'S FAILURE PATH, ACTUALLY RUN ───────────────────────── */

await page.waitForSelector('#state-explorer [data-testid="an-explorer-missing"]', { timeout: 15000 });
const explorerText = await page.$eval('#state-explorer [data-testid="an-explorer-missing"]', (e) => e.innerText);
ok(explorerText.includes('Explorer is not installed in this build'),
  '9d the rejected lazy import lands on the placeholder, not a blank panel');
ok(explorerText.includes('The dashboard is unaffected'),
  '9d …and says the dashboard is unaffected');

/* ── 10. nothing threw ───────────────────────────────────────────────────── */

ok(consoleErrors.length === 0, '10 no console errors during render',
  consoleErrors.slice(0, 4).join(' | '));

const unexpected404 = notFound.filter((u) => !u.includes(EXPECTED_404));
ok(unexpected404.length === 0, '10 no unexpected 404s', unexpected404.slice(0, 4).join(' | '));
ok(notFound.some((u) => u.includes(EXPECTED_404)),
  `10 the ONE expected 404 is Lane 4's module — the failure path really ran (${notFound.join(', ') || 'none seen'})`);

// The page must have made NO API call: this harness renders from props, and a
// check that quietly hit a live backend would be proving something else.
const apiCalls = notFound.filter((u) => u.includes('/api/'));
ok(apiCalls.length === 0, '10 the harness touched no API', apiCalls.join(' | '));

/* ── screenshots ─────────────────────────────────────────────────────────── */

for (const id of ['state-seeded', 'state-withheld', 'state-loading', 'state-failed', 'state-hostile', 'state-explorer']) {
  const el = await page.$(`#${id}`);
  await el.screenshot({ path: resolve(OUT, `${id}.png`) });
  console.log(`      wrote ${resolve(OUT, `${id}.png`)}`);
}
await page.screenshot({ path: resolve(OUT, 'full.png'), fullPage: true });
console.log(`      wrote ${resolve(OUT, 'full.png')}`);

await browser.close();
await server.close();

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
