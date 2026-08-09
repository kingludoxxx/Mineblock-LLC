// SEEDED RENDER verification — boots vite against ./harness.html, drives it
// with headless chromium, asserts the honesty rules IN THE RENDERED DOM, and
// writes screenshots for inspection (LANE 3, verification only).
//
// The formatter harness proves the FUNCTIONS are honest. This proves the PAGE
// is: that no card, table cell or tooltip re-implements a formatter, that a
// failed request never renders as an empty window, and that every reader is
// pointed at the key the SERVER actually emits.
//
// ⚠️ THE EXPECTATIONS ARE DERIVED FROM ./seed.generated.json, not hardcoded.
// The seeds are captured from Lane 1's and Lane 2's real services, so an
// assertion written against the capture fails the moment a lane renames a key —
// which is precisely the drift that shipped last round and was invisible
// because both the fixture and the reader shared one wrong belief.
//
// Run:  node client/src/pages/analytics/dashboard/__checks__/screenshot.mjs
// Out:  client/src/pages/analytics/dashboard/__checks__/out/*.png (gitignored)
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '../../../../..');
const OUT = resolve(HERE, 'out');
const PAGE = '/src/pages/analytics/dashboard/__checks__/harness.html';

const SEED = JSON.parse(readFileSync(resolve(HERE, 'seed.generated.json'), 'utf8'));
const DASH = SEED.dashboard;
const TTL = SEED.dashboard_ttl;
const MKT = SEED.marketing;
const MKT_UN = SEED.marketing_unattributed;

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); }
};
const eq = (got, want, m) => ok(got === want, m, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const money = (n) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Math.abs(Number(n)));
const int = (n) => new Intl.NumberFormat('en-US').format(Math.round(Number(n)));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Mirrors dashFormat.prettyRange, so the assertion does not import the UI. */
const prettyDayOf = (iso) => {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(iso);
};
const prettyRangeOf = (a, b) => (a === b
  ? prettyDayOf(a)
  : `${prettyDayOf(a).replace(/, \d{4}$/, '')} – ${prettyDayOf(b)}`);

mkdirSync(OUT, { recursive: true });

const server = await createServer({
  root: CLIENT_ROOT,
  configFile: resolve(CLIENT_ROOT, 'vite.config.js'),
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
});
await server.listen();
const base = 'http://127.0.0.1:5199';
console.log(`\n== seeded render check == ${base}${PAGE} ==`);
console.log(`   payloads: metrics@${SEED.captured_from.metrics_commit} attribution@${SEED.captured_from.attribution_commit}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const notFound = [];
// THE ONE EXPECTED NETWORK FAILURE is Lane 4's module: the explorer state
// exists to make that request fail. Chromium logs it as a bare "Failed to load
// resource: 404" with no URL, so the URL is captured from the response event
// and asserted separately — filtering the console line alone would also hide a
// 404 on something that matters.
const EXPECTED_404 = 'explorer/index.jsx';
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource.*404/.test(t)) return;
  consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

/* ── serve the captured payloads to the end-to-end state ─────────────────── */
// Route interception, not a mocked axios: the page's real client, real params
// and real error handling all run. Anything NOT matched here still 404s and is
// caught by the assertions at the end.
const served = { dashboard: 0, band: 0, marketing: 0 };
const json = (route, body) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});
await page.route('**/api/v1/funnel-metrics/dashboard*', (route) => {
  served.dashboard += 1; return json(route, DASH);
});
await page.route('**/api/v1/funnel-metrics/band*', (route) => {
  served.band += 1; return json(route, SEED.band);
});
await page.route('**/api/v1/funnel-attribution/marketing*', (route) => {
  served.marketing += 1; return json(route, MKT);
});

await page.goto(`${base}${PAGE}`, { waitUntil: 'networkidle' });
await page.waitForSelector('#state-measured [data-testid="an-funnel-performance-table"]', { timeout: 30000 });
await page.waitForTimeout(1200); // recharts sizes off a ResizeObserver tick

const DASHV = '[data-testid="an-dashboard-page"]';
const textOf = (sel) => page.$eval(sel, (e) => e.innerText);
const trimOf = (sel) => page.$eval(sel, (e) => e.textContent.trim());

/* ── 1. every state mounted ──────────────────────────────────────────────── */

const sections = await page.$$eval('section[id^="state-"]', (els) => els.map((e) => e.id));
eq(sections.length, 8, `1 eight render states mounted (${sections.join(', ')})`);
const dashCount = await page.$$eval(DASHV, (e) => e.length);
eq(dashCount, 7, '1 seven DashboardView instances (six direct + the live route)');

/* ── 2. provenance, from the CAPTURED window ─────────────────────────────── */

const prov = await trimOf('#state-measured [data-testid="an-dash-provenance"]');
ok(prov.includes('Madrid time'),
  `2 the provenance prints the zone the SERVER named (${DASH.window.timezone}) as "Madrid time" (${prov})`);
ok(prov.includes('Compared to'), '2 provenance names the compare window');
ok(prov.includes(`${DASH.breakdown_summary.funnels.rows_total} funnels`),
  `2 provenance prints the wire funnel count (${DASH.breakdown_summary.funnels.rows_total}) (${prov})`);
ok(!prov.includes('undefined') && !prov.includes('NaN'), '2 provenance has no undefined/NaN clause');

/* ── 3. FINDING #1 — the money column is net_sales and the cards SAY so ──── */

eq(DASH.breakdown_summary.funnels.total_metric, 'net_sales',
  '3 (capture) Lane 1 folds the funnel breakdown on net_sales');
const funnelSub = await trimOf('#state-measured [data-testid="an-card-sales-by-funnel"] p.text-\\[11px\\]');
ok(funnelSub.includes('Net sales'),
  `3 the funnel donut captions itself NET, not "Sales" (${funnelSub})`);
const srcSub = await textOf('#state-measured [data-testid="an-card-sources"]');
ok(srcSub.includes('Net sales'), '3 the UTM source card captions itself NET');
const tableBasis = await trimOf('#state-measured [data-testid="an-funnel-performance-basis"]');
ok(tableBasis.includes('Net sales'), `3 the funnel table names its money column (${tableBasis})`);
// …and the row value is the net_sales figure, not a gross one it never had.
const topFunnel = DASH.breakdown_summary.funnels.rows[0];
const funnelDonut = await textOf('#state-measured [data-testid="an-card-sales-by-funnel"]');
ok(funnelDonut.includes(money(topFunnel.net_sales)),
  `3 the donut plots the row's net_sales (${money(topFunnel.net_sales)})`);

/* ── 4. FINDING #6 — truncation + totals from the WIRE ───────────────────── */

const mkFooter = await trimOf('#state-measured [data-testid="an-card-marketing-footer"]');
// TWO cuts stack: the server ranked 28 buckets down to the 12 it sent, and the
// card draws its top 8 of those. The footer must count what it DREW against the
// WIRE total — "Top 8 of 28" — not against the page it happened to receive.
const mkDrawn = Math.min(8, MKT.rows.filter((r) => Number(r.sales) > 0).length);
ok(mkFooter.includes(`Top ${mkDrawn} of ${MKT.totals.rows_total}`),
  `4 the marketing card counts what it drew against the WIRE total (${mkFooter})`);
ok(mkFooter.includes(money(MKT.totals.sales)),
  `4 …and prints the PRE-truncation folded total ${money(MKT.totals.sales)} (${mkFooter})`);
const funnelFooter = await trimOf('#state-measured [data-testid="an-card-sales-by-funnel-footer"]');
ok(funnelFooter.includes(money(DASH.breakdown_summary.funnels.total)),
  `4 the donut footer prints the wire total ${money(DASH.breakdown_summary.funnels.total)} (${funnelFooter})`);
ok(/All \d+|Top \d+ of \d+/.test(funnelFooter),
  `4 …with a count claim backed by the wire rows_total (${funnelFooter})`);
// The centre of the donut is the PERIOD total, not the sum of drawn slices.
const donutCentre = await trimOf('#state-measured [data-testid="an-card-sales-by-funnel"] .absolute span:first-child');
ok(donutCentre.length > 1, `4 the donut centre renders the period total (${donutCentre})`);

/* ── 5. FINDING #3 — warnings are {source, reason} OBJECTS ───────────────── */

ok(Array.isArray(TTL.meta.warnings) && typeof TTL.meta.warnings[0] === 'object',
  '5 (capture) Lane 1 emits object-shaped warnings');
const ttlWarn = await textOf('#state-ttl [data-testid="an-dash-warnings"]');
for (const w of TTL.meta.warnings) {
  ok(ttlWarn.includes(w.reason.slice(0, 40)),
    `5 the "${w.source}" warning's REASON is rendered (not dropped as a non-string)`);
  ok(ttlWarn.includes(w.source), `5 …and its source is named (${w.source})`);
}
ok(!ttlWarn.includes('[object Object]'), '5 no warning stringifies as [object Object]');

/* ── 6. FINDING #4 — sessions_unknown fires the TTL path ─────────────────── */

eq(TTL.meta.sessions_unknown, true, '6 (capture) the TTL window really does set sessions_unknown');
eq(TTL.kpis.sessions, null, '6 (capture) …and sessions really are withheld');
const ttlNote = await page.$('#state-ttl [data-testid="an-funnel-sessions-note"]');
ok(!!ttlNote, '6 the funnel table prints the TTL note — the path actually fires');
const ttlNoteText = ttlNote ? (await ttlNote.innerText()) : '';
ok(ttlNoteText.includes('90-day tracking retention'), '6 …and names the retention as the reason');
// …and the sessions COLUMN really dashes, with the TTL reason on the cell.
const ttlSessCell = await page.$eval(
  `#state-ttl [data-testid="an-funnel-row-${TTL.breakdown_summary.funnels.rows[0].key}"] td:nth-child(2)`,
  (e) => ({ text: e.textContent.trim(), why: e.querySelector('span')?.getAttribute('title') || '' }));
eq(ttlSessCell.text, '—', '6 the sessions cell is an em dash');
ok(ttlSessCell.why.includes('90-day tracking retention'),
  `6 …and the cell's own reason is the TTL one, not the generic one (${ttlSessCell.why})`);
// The MEASURED window must NOT show the note — it is not a decoration.
ok(!(await page.$('#state-measured [data-testid="an-funnel-sessions-note"]')),
  '6 a healthy window shows no retention note');
const ttlSessionsTile = await trimOf('#state-ttl [data-testid="an-kpi-sessions"]');
ok(ttlSessionsTile.includes('—'), `6 the sessions KPI is an em dash, not 0 (${ttlSessionsTile})`);
ok(!/\b0\b/.test(ttlSessionsTile.replace(/[^0-9\s]/g, ' ')),
  `6 …and prints no zero anywhere on the tile (${ttlSessionsTile})`);
// Orders ARE measured in that window and must still print.
ok((await textOf('#state-ttl' + ' ' + DASHV)).includes(int(TTL.kpis.orders)),
  `6 …while the measured order count (${int(TTL.kpis.orders)}) still prints`);

/* ── 7. FINDING #5 — returning rate never fabricates 100% ────────────────── */

const wRet = await trimOf('#state-withheld [data-testid="an-kpi-returning-rate"]');
ok(wRet.includes('—'), `7 a withheld new/returning split renders an em dash (${wRet})`);
ok(!wRet.includes('100.0%') && !wRet.includes('100%'),
  `7 …and NEVER 100%, which is what Number(null)+n used to produce (${wRet})`);

/* ── 8. FINDING #2 — a FAILED load never prints an empty state ───────────── */

const failedEmpties = await page.$$eval('#state-failed [data-testid="an-card-empty"]', (e) => e.length);
eq(failedEmpties, 0, '8 NOT ONE card shows "No data for this date range" on a cold failure');
const failedWells = await page.$$eval('#state-failed [data-testid="an-card-failed"]', (e) => e.length);
ok(failedWells >= 6, `8 every card shows the couldn't-load well instead (${failedWells})`);
const failedTable = await page.$('#state-failed [data-testid="an-funnel-performance-failed"]');
ok(!!failedTable, '8 the funnel table shows its own failure well');
const failedTableText = failedTable ? await failedTable.innerText() : '';
ok(failedTableText.includes('NOT'), '8 …and explicitly denies "no funnel took money"');
const failedEmptyTable = await page.$('#state-failed [data-testid="an-funnel-performance-empty"]');
ok(!failedEmptyTable, '8 the forbidden "No funnel took money in this window" is absent');
// The attribution failure is surfaced at page level AND on the card.
ok(!!(await page.$('#state-failed [data-testid="an-dash-marketing-error"]')),
  '8 the attribution rejection is surfaced as a page-level notice');
ok((await textOf('#state-failed [data-testid="an-card-marketing"]')).includes('Couldn'),
  '8 …and the marketing card itself says it could not load');
ok(!(await textOf('#state-failed [data-testid="an-card-marketing"]')).includes('No attributed sales'),
  '8 …and NEVER "No attributed sales in this date range"');

/* ── 9. FINDING #13 — the two unattributed facts, named separately ───────── */

const unRows = (MKT_UN.rows || []).filter((r) => r.is_unattributed);
ok(unRows.length >= 2, `9 (capture) the source fold really carries both unattributed states (${unRows.map((r) => r.attribution).join(', ')})`);
const ttlMk = await textOf('#state-ttl [data-testid="an-card-marketing"]');
for (const r of unRows) {
  ok(ttlMk.includes(r.label),
    `9 the server's own label "${r.label}" is rendered VERBATIM, not re-derived`);
}
ok(ttlMk.includes('nothing measured') && ttlMk.includes('visit seen, not tagged'),
  '9 the two unattributed states are distinguished on the rows');
const ttlMkNotice = await page.$('#state-ttl [data-testid="an-card-marketing-notice"]');
ok(!!ttlMkNotice && (await ttlMkNotice.innerText()).includes('not the same problem'),
  '9 …and the card says they are different problems');
ok(ttlMk.includes(MKT_UN.revenue_basis_label.slice(0, 25)),
  '9 the revenue basis is printed (it differs from /roas by construction)');

/* ── 10. FINDING #11 — a non-funnel bucket is not clickable ──────────────── */

// NO SYNTHETIC ROW NEEDED: Lane 1's real funnel fold already emits a '(none)'
// catch-all bucket, so this runs against the captured payload.
ok(DASH.breakdown_summary.funnels.rows.some((r) => r.key === '(none)'),
  '10 (capture) the real funnel fold contains a "(none)" catch-all bucket');
const noneRow = await page.$('#state-measured [data-testid="an-funnel-row-(none)"]');
ok(!!noneRow, '10 the "(none)" catch-all renders as a real row');
const noneCls = noneRow ? await noneRow.getAttribute('class') : '';
ok(!noneCls.includes('cursor-pointer'), `10 …and is NOT clickable (${noneCls})`);
const realRowCls = await page.$eval(
  `#state-measured [data-testid="an-funnel-row-${DASH.breakdown_summary.funnels.rows[0].key}"]`,
  (e) => e.getAttribute('class'));
ok(realRowCls.includes('cursor-pointer'), '10 …while a real funnel row still is');
const scopeOpts = await page.$$eval('#state-measured [data-testid="an-dash-scope-select"] option',
  (els) => els.map((e) => e.value));
ok(!scopeOpts.includes('(none)'), `10 …and it is not offered in the scope selector (${scopeOpts.join(',')})`);
const noneMoney = DASH.breakdown_summary.funnels.rows.find((r) => r.key === '(none)').net_sales;
ok((await textOf('#state-measured [data-testid="an-funnel-performance"]')).includes(money(noneMoney)),
  `10 …but its money (${money(noneMoney)}) is still shown — a real bucket is never dropped`);

/* ── 11. the absent-column disclosure (Lane 1 folds 3 metrics per funnel) ── */

const absentNote = await page.$('#state-measured [data-testid="an-funnel-absent-note"]');
ok(!!absentNote, '11 columns this payload does not carry per funnel are NAMED, not left as dashes');
const absentText = absentNote ? await absentNote.innerText() : '';
ok(absentText.includes('absence in the response'),
  '11 …and named as an absence, not as a withheld measurement');
const headers = await page.$$eval('#state-measured [data-testid="an-funnel-performance-table"] thead th',
  (els) => els.map((e) => e.textContent.trim()));
ok(headers.includes('Net') && headers.includes('Orders') && headers.includes('AOV'),
  `11 the columns the payload DOES carry are drawn (${headers.join(' · ')})`);
ok(!headers.includes('COGS'), '11 …and a column no row carries is not drawn as 8 rows of dashes');

/* ── 12. the take rate that cannot be a proportion ───────────────────────── */

const takeRate = DASH.kpis.upsell_lines.take_rate;
if (takeRate !== null && Number(takeRate) > 100) {
  const tr = await trimOf('#state-measured [data-testid="an-card-order-value-take-rate"]');
  ok(tr.includes('over 100%'),
    `12 an impossible take rate (${takeRate}%) is printed AND marked, not silently rendered (${tr})`);
  ok(tr.includes(String(Math.round(Number(takeRate)))) || tr.includes(Number(takeRate).toFixed(1)),
    '12 …the reported value is not clamped or hidden');
} else {
  ok(true, `12 take rate is within range in this capture (${takeRate}) — nothing to mark`);
}

/* ── 13. band.in_window ──────────────────────────────────────────────────── */

eq(DASH.band.in_window, true, '13 (capture) today IS inside the measured window');
ok(!(await page.$('#state-measured [data-testid="an-dash-band-out-of-window"]')),
  '13 so the out-of-window line is absent');
eq(TTL.band.in_window, false, '13 (capture) today is NOT inside the past-TTL window');
ok(!!(await page.$('#state-ttl [data-testid="an-dash-band-out-of-window"]')),
  '13 so the band says its counters are not part of the report below');

/* ── 14. holes, and the wording that admits them ─────────────────────────── */

// THE BUG THIS CATCHES: a past-TTL window returns a FULL series of null
// sessions. Rendering "No data for this date range" over it claims we asked and
// nobody visited, for a period whose visitors merely expired.
const ttlMeasured = TTL.series.filter((p) => p.sessions !== null).length;
eq(ttlMeasured, 0, '14 (capture) every session bucket in the TTL window is withheld');
const sessWell = await page.$('#state-ttl [data-testid="an-card-sessions-over-time"] [data-testid="an-card-withheld"]');
ok(!!sessWell, '14 the sessions chart renders the WITHHELD well, not the empty state');
ok(!(await page.$('#state-ttl [data-testid="an-card-sessions-over-time"] [data-testid="an-card-empty"]')),
  '14 …and never "No data for this date range" over expired traffic');
const sessWellText = sessWell ? await sessWell.innerText() : '';
ok(sessWellText.includes('90-day tracking retention'),
  `14 …and names the retention as the reason (${sessWellText.replace(/\n/g, ' ')})`);
ok(sessWellText.includes('not a measurement of zero'), '14 …and says so explicitly');
// The measured window still draws a real chart with a real caption.
ok(!!(await page.$('#state-measured [data-testid="an-card-sales-over-time-caption"]')),
  '14 the measured window draws its chart normally');
const salesCaption = await trimOf('#state-measured [data-testid="an-card-sales-over-time-caption"]');
ok(salesCaption.includes('vs '), `14 the caption names the compare window (${salesCaption})`);

/* ── 15. THE WITHHELD PAGE INVENTS NOTHING ───────────────────────────────── */

const withheldText = await textOf(`#state-withheld ${DASHV}`);
for (const forbidden of ['$0.00', '0.00%', '0.00x', '$0K', '0.0%']) {
  ok(!withheldText.includes(forbidden),
    `15 the withheld page prints no "${forbidden}"`,
    withheldText.split('\n').filter((l) => l.includes(forbidden)).slice(0, 3).join(' | '));
}
const badCells = await page.$$eval(`#state-withheld ${DASHV} .tabular-nums`, (els) => els
  .map((e) => e.textContent.trim())
  .filter((t) => /^[-−]?\$?0(\.0+)?%?x?$/.test(t)));
eq(badCells.length, 0, `15 no zero-valued numeric cell on the withheld page (${badCells.join(', ')})`);
ok(withheldText.includes('Madrid time'), '15 the withheld page still names the reporting zone');
ok(withheldText.includes('last successful load'), '15 …and says the refresh failed over cached figures');

/* #16 — AN EXACT EM-DASH COUNT PER STATE.
   A range ("more than 40") passes whether the page dashes 41 cells or 400, so
   it cannot notice a reader that quietly stopped finding a key. These are
   PINNED: a change here is a real change in what the page refuses to claim, and
   it must be re-inspected in the screenshot rather than re-baselined. */
const dashCounts = {};
for (const id of ['state-measured', 'state-ttl', 'state-withheld', 'state-failed']) {
  const t = await textOf(`#${id} ${DASHV}`);
  dashCounts[id] = (t.match(/—/g) || []).length;
}
console.log(`      em-dash census: ${JSON.stringify(dashCounts)}`);
// PINNED against metrics@3e42a8e / attribution@14ce8f9. These are not
// thresholds: each number is how many things the page refuses to claim in that
// state, and a change means either a reader started finding a key it used to
// miss (good) or stopped finding one it used to read (the exact regression this
// suite exists for). Re-inspect the screenshot before touching a number here;
// re-capture the seeds and these will move legitimately.
const EXPECTED_DASHES = JSON.parse(process.env.EXPECT_DASHES || JSON.stringify({
  'state-measured': 15,
  'state-ttl': 32,
  'state-withheld': 62,
  'state-failed': 25,
}));
for (const [id, n] of Object.entries(EXPECTED_DASHES)) {
  eq(dashCounts[id], n, `16 em-dash count is exactly ${n} on ${id}`);
}

/* ── 17. loading is not the empty state and not the dead state ───────────── */

const skeletons = await page.$$eval('#state-loading [data-testid="an-kpi-skeleton"], #state-loading [data-testid="an-card-skeleton"]', (e) => e.length);
ok(skeletons >= 8, `17 the loading page renders skeletons (${skeletons})`);
const loadingText = await textOf('#state-loading');
ok(loadingText.includes('loading…'), '17 the loading tiles say so in words');
ok(!loadingText.includes('No data for this date range'),
  '17 loading NEVER shows the empty state — that would assert a measurement');
ok(!(await page.$('#state-loading [data-testid="an-card-failed"]')),
  '17 …and never the failure well either');

/* ── 18. a MALFORMED payload renders, it does not throw ──────────────────── */

ok(!!(await page.$(`#state-hostile ${DASHV}`)), '18 the malformed payload still renders a page');
ok(!!(await page.$('#state-hostile [data-testid="an-funnel-performance"]')), '18 …including the funnel table');
const hostileWarn = await trimOf('#state-hostile [data-testid="an-dash-warnings"]');
ok(hostileWarn.includes('one real warning') && hostileWarn.includes('a real reason'),
  `18 a warnings array of mixed junk yields only the real entries (${JSON.stringify(hostileWarn)})`);
ok(!hostileWarn.includes('[object Object]') && !hostileWarn.includes('null'),
  '18 …and no junk entry is stringified onto the page');

/* ── 18b. THE REAL ROUTE, END TO END ─────────────────────────────────────── */

// This is the only state that exercises index.jsx, useDashboardData and the
// axios client. A reference-before-declaration in the page component crashes
// here and nowhere else in this suite.
await page.waitForSelector('#state-live [data-testid="an-dashboard-page"]', { timeout: 20000 });
ok(served.dashboard >= 1, `18b the real page fetched the composite (${served.dashboard}x)`);
ok(served.marketing >= 1, `18b …and the attribution call (${served.marketing}x)`);
ok(!!(await page.$('#state-live [data-testid="an-funnel-performance-table"]')),
  '18b the funnel table rendered from a real HTTP response');
const liveProv = await trimOf('#state-live [data-testid="an-dash-provenance"]');
ok(liveProv.includes('Madrid time'), `18b the provenance rendered end to end (${liveProv})`);
// THE WINDOW-ECHO ADOPTION: the page seeds its own 30-day guess, the server
// answers with the window it actually served, and the page adopts it once.
ok(liveProv.includes(prettyRangeOf(DASH.window.start, DASH.window.end)),
  `18b the served window was adopted and is what the header prints (${liveProv})`);
const liveErr = await page.$('#state-live [data-testid="an-dash-error"]');
ok(!liveErr, '18b no error banner on a healthy end-to-end load');

/* ── 19. THE EXPLORER'S FAILURE PATH, ACTUALLY RUN ───────────────────────── */

await page.waitForSelector('#state-explorer [data-testid="an-explorer-missing"]', { timeout: 15000 });
const explorerText = await textOf('#state-explorer [data-testid="an-explorer-missing"]');
ok(explorerText.includes('Explorer is not installed in this build'),
  '19 the rejected lazy import lands on the placeholder, not a blank panel');
ok(explorerText.includes('The dashboard is unaffected'), '19 …and says the dashboard is unaffected');

/* ── 20. nothing threw, nothing else 404'd, no API was touched ───────────── */

ok(consoleErrors.length === 0, '20 no console errors during render',
  JSON.stringify(consoleErrors.slice(0, 4)));
const unexpected404 = notFound.filter((u) => !u.includes(EXPECTED_404));
eq(unexpected404.length, 0, '20 no unexpected 404s', unexpected404.slice(0, 4).join(' | '));
ok(notFound.some((u) => u.includes(EXPECTED_404)),
  `20 the ONE expected 404 is Lane 4's module — the failure path really ran (${notFound.join(', ') || 'none seen'})`);
const apiCalls = notFound.filter((u) => u.includes('/api/'));
eq(apiCalls.length, 0, '20 the harness touched no API', apiCalls.join(' | '));

/* ── screenshots ─────────────────────────────────────────────────────────── */

for (const id of sections) {
  const el = await page.$(`#${id}`);
  await el.screenshot({ path: resolve(OUT, `${id}.png`) });
}
await page.screenshot({ path: resolve(OUT, 'full.png'), fullPage: true });
console.log(`      wrote ${sections.length + 1} screenshots to ${OUT}`);

await browser.close();
await server.close();

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
