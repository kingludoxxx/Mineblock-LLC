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
// LANE 5 — captured from runInsights / computeCohorts (./captureInsightsSeed.mjs).
const ISEED = JSON.parse(readFileSync(resolve(HERE, 'insights.seed.generated.json'), 'utf8'));
const INS = ISEED.insights;
const INS_BLIND = ISEED.insights_degraded;
const COH = ISEED.cohorts;

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); }
};
const eq = (got, want, m) => ok(got === want, m, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
/**
 * ⚠️ USE THIS FOR ARRAYS AND OBJECTS. `eq` above is `got === want`, so two
 * structurally identical arrays NEVER compare equal — and the failure message
 * prints the two sides looking the same, which is the most confusing possible
 * red. Two assertions in the Lane 5 block hit exactly that before this existed.
 */
const deepEq = (got, want, m) => ok(
  JSON.stringify(got) === JSON.stringify(want), m,
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
);

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
console.log(`   payloads: metrics@${SEED.captured_from.metrics_commit} attribution@${SEED.captured_from.attribution_commit} insights@${ISEED.captured_from.commit}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const notFound = [];
// PRE-MERGE this was Lane 4's missing module 404'ing. POST-MERGE the module
// resolves and the expected network failure is instead the sealed API boundary
// below aborting the merged explorer's mount calls (net::ERR_FAILED).
//
// Both are logged by Chromium as a bare "Failed to load resource" line carrying
// NO URL, so filtering the console line alone would also hide a failure on
// something that matters. The discipline is unchanged: drop the URL-less line
// here, and assert the actual URLs structurally — 404s from the response event
// (`notFound`), aborted requests from the route handler (`blocked`).
const EXPECTED_404 = 'explorer/index.jsx';
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource.*(404|net::ERR_FAILED)/.test(t)) return;
  consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

/* ── serve the captured payloads to the end-to-end state ─────────────────── */
// Route interception, not a mocked axios: the page's real client, real params
// and real error handling all run. Anything NOT matched here still 404s and is
// caught by the assertions at the end.
const served = { dashboard: 0, band: 0, marketing: 0, insights: 0, cohorts: 0 };
const json = (route, body) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});
// SEALED BOUNDARY, registered FIRST so the specific stubs below win (Playwright
// runs the most recently added matching handler first). Section 8 mounts the
// REAL explorer post-merge, and its mount effects fire their own calls — which
// the vite dev proxy would forward to the production host. Aborting here is
// what keeps "this harness never touches a live API" a fact rather than a hope;
// the explorer's own reader paths are proven by explorerRuntime.harness.mjs.
const blocked = [];
await page.route('**/api/**', (route) => {
  blocked.push(route.request().url());
  return route.abort();
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
// LANE 5's two reads, served from the SAME captured payloads the seeded states
// render — so the end-to-end state and the direct-mount states cannot disagree.
await page.route('**/api/v1/funnel-insights/insights*', (route) => {
  served.insights += 1; return json(route, INS);
});
await page.route('**/api/v1/funnel-insights/cohorts*', (route) => {
  served.cohorts += 1; return json(route, COH);
});

await page.goto(`${base}${PAGE}`, { waitUntil: 'networkidle' });
await page.waitForSelector('#state-measured [data-testid="an-funnel-performance-table"]', { timeout: 30000 });
await page.waitForTimeout(1200); // recharts sizes off a ResizeObserver tick

const DASHV = '[data-testid="an-dashboard-page"]';
const textOf = (sel) => page.$eval(sel, (e) => e.innerText);
const trimOf = (sel) => page.$eval(sel, (e) => e.textContent.trim());

/* ── 1. every state mounted ──────────────────────────────────────────────── */

const sections = await page.$$eval('section[id^="state-"]', (els) => els.map((e) => e.id));
eq(sections.length, 12, `1 twelve render states mounted (${sections.join(', ')})`);
const dashCount = await page.$$eval(DASHV, (e) => e.length);
eq(dashCount, 11, '1 eleven DashboardView instances (ten direct + the live route)');

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
// ── WHERE THE DASHES ARE, per card, printed (not asserted) ────────────────
// The totals above are the pin; this breakdown is what makes re-baselining
// them an INSPECTION rather than a shrug. When a count moves, this line says
// which card moved it, so "a reader stopped finding a key" and "a new card
// legitimately refuses more things" can be told apart without a screenshot.
for (const id of ['state-measured', 'state-withheld']) {
  const per = await page.$$eval(`#${id} ${DASHV} [data-testid^="an-"]`, (els) => {
    const out = {};
    for (const e of els) {
      // Only count a dash against the OUTERMOST card that contains it, so a
      // nested testid does not double-count its parent's cells.
      if (e.parentElement && e.parentElement.closest('[data-testid^="an-card"], [data-testid^="an-insights"]')) continue;
      const n = (e.innerText.match(/—/g) || []).length;
      if (n > 0) out[e.getAttribute('data-testid')] = n;
    }
    return out;
  });
  console.log(`      ${id} by card: ${JSON.stringify(per)}`);
}
// PINNED against metrics@3e42a8e / attribution@14ce8f9. These are not
// thresholds: each number is how many things the page refuses to claim in that
// state, and a change means either a reader started finding a key it used to
// miss (good) or stopped finding one it used to read (the exact regression this
// suite exists for). Re-inspect the screenshot before touching a number here;
// re-capture the seeds and these will move legitimately.
//
// ── RE-BASELINED FOR LANE 5, and here is the whole of the accounting ────────
// The page grew six cards, so every state refuses more things than it did. The
// screenshots in ./out/ were re-inspected before these numbers moved, and the
// per-card breakdown printed above is what makes the next move diagnosable
// rather than a shrug.
//
//   state-measured  15 → 73  (+58)
//       +50  an-card-cohorts — THE AGING GUARD, and it is the point of the
//            lane: the card draws the 8 newest cohorts, of which seven are
//            0–6 days old (D7/D30/D90 un-aged ⇒ 6 dashes each) and one is
//            exactly 7 days old (D30/D90 un-aged ⇒ 4), plus the two prose
//            em dashes in the card's own footer and warnings. Every one of
//            those cells is a horizon nobody has observed yet, and check 23
//            asserts structurally that they are dashes and not $0.00.
//        +8  the five new masonry cards (waterfall / movers / economics /
//            top lists / last 60) declining to state what they were not given.
//   state-ttl       32 → 46  (+14)   the same five cards over a withheld window
//   state-withheld  62 → 76  (+14)   ditto, every measurement nulled
//   state-failed    25 → 38  (+13)   ditto, cold failure (no cohort card: that
//                                    state passes no cohort props at all)
//
// ⚠️ The insight strip contributes ZERO. It did contribute 3 on the first run,
// entirely from em dashes inside FUNNEL NAMES in the capture fixture
// ("Alpha — Breast Lift") reaching card headlines. Those are punctuation, not
// withheld measurements, and a pin that counts them is measuring the wrong
// thing — so the fixture's funnels were renamed rather than the number nudged.
const EXPECTED_DASHES = JSON.parse(process.env.EXPECT_DASHES || JSON.stringify({
  'state-measured': 73,
  'state-ttl': 46,
  'state-withheld': 76,
  'state-failed': 38,
}));
for (const [id, n] of Object.entries(EXPECTED_DASHES)) {
  eq(dashCounts[id], n, `16 em-dash count is exactly ${n} on ${id}`);
}

/* #16b — THE SHARPER PIN: em dashes in NUMERIC CELLS ONLY.
   The census above counts every em dash on the page, including the ones that
   are PUNCTUATION in a card's explanatory prose. That dilution is why the
   Lane 5 re-baseline needed a paragraph of accounting, and it is why a
   half-broken reader could in principle hide inside a prose edit that moved the
   total back. `.tabular-nums` is worn by every cell in this workspace that
   holds a figure, so counting dashes there counts EXACTLY the measurements the
   page refuses to state — nothing else. */
const cellDashes = {};
for (const id of ['state-measured', 'state-ttl', 'state-withheld', 'state-failed']) {
  cellDashes[id] = await page.$$eval(`#${id} ${DASHV} .tabular-nums`, (els) => els
    .filter((e) => e.textContent.trim() === '—').length);
}
console.log(`      numeric-cell dash census: ${JSON.stringify(cellDashes)}`);

/** Which testid owns each dashed numeric cell — the diagnostic for a move. */
const dashOwners = async (id) => {
  const where = await page.$$eval(`#${id} ${DASHV} .tabular-nums`, (els) => els
    .filter((e) => e.textContent.trim() === '—')
    .map((e) => {
      const owner = e.closest('[data-testid]');
      return owner ? owner.getAttribute('data-testid') : '(no testid)';
    }));
  const tally = {};
  for (const w of where) tally[w] = (tally[w] || 0) + 1;
  return tally;
};
for (const id of ['state-measured', 'state-failed']) {
  console.log(`      ${id} numeric dashes by owner: ${JSON.stringify(await dashOwners(id))}`);
}

// MEASURED, then pinned — not guessed. The first cut of this block pinned
// `state-failed: 0` on the hypothesis that a cold failure renders no numeric
// cells at all. The run refuted it: eight KPI tiles and three line-card
// headlines legitimately print an em dash BESIDE their own "couldn't load"
// text, which is the KPI tile's existing (and correct) design. The hypothesis
// was replaced with the assertion below, which checks the thing that actually
// matters.
const EXPECTED_CELL_DASHES = JSON.parse(process.env.EXPECT_CELL_DASHES || JSON.stringify({
  // Every one of these 46 is an UN-AGED COHORT CELL — see the assertion below,
  // which proves it rather than asserting it in a comment.
  'state-measured': 46,
  'state-ttl': 16,
  'state-withheld': 46,
  // 8 KPI tiles + 3 line-card headlines, each beside its own failure text.
  'state-failed': 11,
}));
for (const [id, n] of Object.entries(EXPECTED_CELL_DASHES)) {
  eq(cellDashes[id], n, `16b numeric cells refusing to state a figure: exactly ${n} on ${id}`);
}

// ON A HEALTHY WINDOW, EVERY REFUSAL IS THE AGING GUARD — and nothing else.
// This is the sharp version of the census: it says not just how many figures
// the page declines to state, but that all of them are the ONE thing that is
// genuinely unobservable (a horizon a cohort has not lived to reach). A reader
// that quietly stopped finding a key would add a dash somewhere else and fail
// here with the offending card named.
const measuredOwners = await dashOwners('state-measured');
const nonCohort = Object.entries(measuredOwners).filter(([k]) => !k.startsWith('an-card-cohorts'));
deepEq(nonCohort, [],
  '16b on a fully measured window EVERY dashed figure is an un-aged cohort cell — '
  + 'no other card refuses to state anything',
  JSON.stringify(nonCohort));

// ON A COLD FAILURE, A DASH IS NEVER ALONE. Each dashed figure sits inside a
// surface that ALSO says the request did not come back — so no dash on that
// page can be read as "measured, and the answer is nothing".
const orphanDashes = await page.$$eval(`#state-failed ${DASHV} .tabular-nums`, (els) => els
  .filter((e) => e.textContent.trim() === '—')
  .map((e) => {
    const card = e.closest('section, [data-testid]');
    const txt = card ? card.innerText : '';
    return /couldn’t load|couldn't load|Couldn’t load|Couldn't load/.test(txt)
      ? null : (card && card.getAttribute('data-testid')) || '(no testid)';
  })
  .filter(Boolean));
deepEq(orphanDashes, [],
  '16b …and on a COLD FAILURE every dashed figure sits beside its own "couldn\'t load" — '
  + 'not one of them can be read as a measurement that came back empty',
  JSON.stringify(orphanDashes));

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

/* ── 19. THE EXPLORER ROUTE, POST-MERGE ──────────────────────────────────── */

// Lane 4 is merged, so the static lazy import RESOLVES and the real explorer
// mounts. The pre-merge placeholder must be gone: leaving that assertion in
// place would have kept passing only while the explorer stayed uninstalled.
await page.waitForSelector('#state-explorer [data-testid="analytics-explorer"]', { timeout: 15000 });
ok(!(await page.$('#state-explorer [data-testid="an-explorer-missing"]')),
  '19 the resolved lazy import mounts the real explorer, not the not-installed placeholder');
ok(!!(await page.$('#state-explorer [data-testid="ax-controls"]')),
  '19 …and the explorer controls rendered through the shared Suspense boundary');

/* ── 20. nothing threw, nothing else 404'd, no API was touched ───────────── */

ok(consoleErrors.length === 0, '20 no console errors during render',
  JSON.stringify(consoleErrors.slice(0, 4)));
eq(notFound.length, 0, '20 no 404s at all — Lane 4 is merged, so nothing fails to resolve',
  notFound.slice(0, 4).join(' | '));
ok(!notFound.some((u) => u.includes(EXPECTED_404)),
  `20 …and the pre-merge explorer 404 is gone (${notFound.join(', ') || 'none seen'})`);
const apiCalls = notFound.filter((u) => u.includes('/api/'));
eq(apiCalls.length, 0, '20 the harness touched no API', apiCalls.join(' | '));
// The seal ITSELF is asserted, not assumed: the explorer really did try to
// fetch, and every one of those attempts died at the boundary.
ok(blocked.length > 0,
  `20 the sealed boundary actually fired — the merged explorer's mount calls were aborted (${blocked.length})`);
const leaked = blocked.filter((u) => !u.includes('/api/v1/funnel-metrics/')
  && !u.includes('/api/v1/funnel-attribution/')
  && !u.includes('/api/v1/funnel-insights/'));
eq(leaked.length, 0, '20 nothing outside the analytics API was even attempted', leaked.slice(0, 4).join(' | '));


/* ══ LANE 5 — THE INSIGHT LAYER ══════════════════════════════════════════════
   Every expectation below is DERIVED FROM ./insights.seed.generated.json, which
   is captured from runInsights / computeCohorts. An assertion written against
   the capture fails the moment the service renames a key — the drift this whole
   suite exists to catch. */

/* ── 21. the strip renders the SERVER'S cards, ranked ────────────────────── */

const stripSel = '#state-measured [data-testid="an-insights-strip"]';
ok(!!(await page.$(stripSel)), '21 the insights strip mounted on the measured state');
ok(INS.insights.length > 0, `21 (capture) the seed really carries cards (${INS.insights.length})`);
for (const c of INS.insights) {
  const el = await page.$(`${stripSel} [data-testid="an-insight-${c.kind}"]`);
  ok(!!el, `21 the '${c.kind}' card is drawn`);
  const t = el ? await el.innerText() : '';
  ok(t.includes(c.headline),
    `21 …with the SERVER'S headline verbatim ("${c.headline}")`, t.replace(/\n/g, ' | '));
}
// RANKED WORST-FIRST, asserted against the DOM ORDER rather than the payload:
// a component that sorted its own way would still pass a payload-only check.
const domSeverities = await page.$$eval(`${stripSel} [data-severity]`,
  (els) => els.map((e) => e.getAttribute('data-severity')));
const RANK = { bad: 0, warn: 1, good: 2, info: 3 };
ok(domSeverities.every((v, i) => i === 0 || RANK[domSeverities[i - 1]] <= RANK[v]),
  `21 …and the DOM order is worst-first (${domSeverities.join(' → ')})`);
// ⚠️ `deepEq`, NOT `eq` — see the helper's own note at the top of this file.
deepEq(domSeverities, INS.insights.map((c) => c.severity),
  '21 …matching the order the server ranked them in, not a client re-sort');
console.log(`      insight severities in the capture: ${[...new Set(domSeverities)].join(', ')}`);

// THE PROSE IS THE EVIDENCE, and it is reachable. It starts collapsed, so the
// assertion has to CLICK — a check that only read the DOM would pass against a
// button wired to nothing.
const firstKind = INS.insights[0].kind;
ok(!(await page.$(`${stripSel} [data-testid="an-insight-${firstKind}-prose"]`)),
  '21 the reasoning starts collapsed');
await page.click(`${stripSel} [data-testid="an-insight-${firstKind}"] button`);
const proseEl = await page.$(`${stripSel} [data-testid="an-insight-${firstKind}-prose"]`);
ok(!!proseEl, '21 …and the "why this fired" control really expands it');
const proseTxt = proseEl ? await proseEl.innerText() : '';
ok(proseTxt.includes(INS.insights[0].prose.slice(0, 40)),
  "21 …showing the server's own sentence, not a re-derived one");

// The check counter comes off `detectors[]`, never off the card count.
const checksLine = await trimOf(`${stripSel} [data-testid="an-insights-strip-checks"]`);
const ranN = INS.detectors.filter((d) => d.ran).length;
ok(checksLine.includes(`${ranN} of ${INS.detectors.length} checks ran`),
  `21 the strip counts the DETECTORS that ran (${ranN}/${INS.detectors.length}), not the cards that fired (${checksLine})`);

/* ── 22. quiet vs blind vs dead — three empties, three meanings ──────────── */

// QUIET: every detector ran, none fired. The one state allowed to say so.
const quietWell = await page.$('#state-insight-none [data-testid="an-insights-strip-quiet"]');
ok(!!quietWell, '22 QUIET the all-ran-none-fired state renders the quiet well');
const quietTxt = quietWell ? await quietWell.innerText() : '';
ok(quietTxt.includes('Nothing stood out'), '22 …and says so');
ok(quietTxt.includes('quiet strip is a result'),
  '22 …and says a quiet strip is a result, not an absence of one');
ok(!(await page.$('#state-insight-none [data-testid="an-insights-strip-blind"]')),
  '22 …with no blind-detector notice, because none was blind');

// BLIND: a detector could not run. Same near-empty strip, opposite meaning.
ok(INS_BLIND.detectors.some((d) => d.ran === false),
  '22 (capture) the degraded payload really carries a ran:false detector');
const blindNote = await page.$('#state-insight-blind [data-testid="an-insights-strip-blind"]');
ok(!!blindNote, '22 BLIND a detector that could not run is NAMED');
const blindTxt = blindNote ? await blindNote.innerText() : '';
ok(blindTxt.includes('could not run'), `22 …in those words (${blindTxt})`);
ok(blindTxt.includes('rules out'),
  '22 …and says the cards above do not rule out what it would have found');
ok(!(await page.$('#state-insight-blind [data-testid="an-insights-strip-quiet"]')),
  '22 …and it NEVER falls through to "nothing stood out" — not the same claim');
const blindCards = await page.$$eval('#state-insight-blind [data-severity]', (e) => e.length);
ok(blindCards === INS_BLIND.insights.length && blindCards > 0,
  `22 …while the ${blindCards} card(s) that did fire are still drawn`);

// DEAD: the request failed. The forbidden sentence must be absent.
const deadStrip = await textOf('#state-insight-dead [data-testid="an-insights-strip"]');
ok(!!(await page.$('#state-insight-dead [data-testid="an-insights-strip"] [data-testid="an-card-failed"]')),
  "22 DEAD a failed insight read renders the couldn't-load well");
ok(deadStrip.includes('HTTP 502'), '22 …naming why');
ok(!deadStrip.includes('Nothing stood out'),
  '22 …and NEVER "Nothing stood out today" — the most dangerous sentence on this page');
ok(!deadStrip.includes('checks ran'),
  '22 …and claims nothing about which checks ran, because none of them did');
ok(!!(await page.$('#state-insight-dead [data-testid="an-funnel-performance-table"]')),
  "22 …while the composite's own figures are unaffected");
ok(!(await page.$('#state-insight-dead [data-testid="an-dash-error"]')),
  '22 …and no page-level error banner is raised for it');

// A SURFACE THAT NEVER ASKED DRAWS NO STRIP. States 2-6 pass no insight props.
for (const id of ['state-ttl', 'state-withheld', 'state-loading', 'state-failed', 'state-hostile']) {
  ok(!(await page.$(`#${id} [data-testid="an-insights-strip"]`)),
    `22 ABSENT ${id} passes no insight props, so NO strip is drawn (never a calm-looking empty one)`);
}

/* ── 23. THE AGING GUARD, in the rendered DOM ────────────────────────────── */

const unagedCohort = COH.cohorts.find((c) => c.ltv.some((v) => v === null));
const agedCohort = COH.cohorts.find((c) => c.ltv.every((v) => v !== null));
ok(!!unagedCohort, '23 (capture) the seed carries a cohort with un-aged horizons');
ok(!!agedCohort, '23 (capture) …and one that is aged at every horizon');
const cohortSel = '#state-measured [data-testid="an-card-cohorts"]';
ok(!!(await page.$(cohortSel)), '23 the cohort card mounted');

// THE CELL THAT MUST NOT BE $0.00.
const unagedIdx = unagedCohort.ltv.findIndex((v) => v === null);
const unagedH = COH.horizons[unagedIdx];
const unagedCell = await page.$(`${cohortSel} [data-testid="an-card-cohorts-ltv-${unagedCohort.key}-${unagedH}"]`);
ok(!!unagedCell, `23 the un-aged D${unagedH} cell for ${unagedCohort.key} is drawn`);
const unagedTxt = unagedCell ? (await unagedCell.textContent()).trim() : '';
eq(unagedTxt, '—', `23 …as an EM DASH (${unagedTxt})`);
ok(unagedTxt !== '$0.00' && unagedTxt !== '0',
  '23 …and NEVER $0.00, which would read as "they came back and spent nothing"');
const unagedTitle = unagedCell ? await unagedCell.getAttribute('title') : '';
ok(unagedTitle.includes('Not aged yet') && unagedTitle.includes('not $0.00'),
  `23 …with the reason on the cell itself (${unagedTitle})`);
eq(unagedCohort.aged[unagedIdx], 0,
  '23 (capture) …and the payload agrees: zero buyers were old enough');

// THE EM DASH IS NOT A BLANKET — proven on the SAME ROW, which is the stronger
// version of this check. `unagedCohort` is aged at D0 and un-aged beyond it, so
// one row carries both states and a card that simply dashed everything (or
// simply printed everything) fails here either way.
//
// ⚠️ The fully-aged cohort in this capture is the OLDEST of 30 and the card
// draws the newest 8, so it is not in the DOM. Asserting against it "passed"
// only by finding an empty string — which is why this check moved onto a row
// the card actually renders.
const agedIdx = unagedCohort.ltv.findIndex((v) => v !== null);
ok(agedIdx >= 0, '23 (capture) the un-aged cohort is aged at at least one horizon');
const sameRowAged = await page.$(`${cohortSel} [data-testid="an-card-cohorts-ltv-${unagedCohort.key}-${COH.horizons[agedIdx]}"]`);
const sameRowTxt = sameRowAged ? (await sameRowAged.textContent()).trim() : '';
ok(sameRowTxt.includes(money(unagedCohort.ltv[agedIdx])),
  `23 …and the SAME ROW's aged D${COH.horizons[agedIdx]} cell prints its real figure `
  + `(${money(unagedCohort.ltv[agedIdx])} vs ${sameRowTxt})`);
ok(!!agedCohort, '23 (capture) a fully-aged cohort exists in the payload for the CSV to carry');

// The weighted average is weighted PER HORIZON.
ok(!!(await page.$(`${cohortSel} [data-testid="an-card-cohorts-average"]`)),
  '23 the size-weighted average row is drawn');
ok(COH.average.aged.some((n, i) => i > 0 && n !== COH.average.aged[0]),
  `23 (capture) the average is weighted over different populations per horizon (${JSON.stringify(COH.average.aged)})`);

// The identity + aging warnings the service emitted are on screen.
const cohWarn = await page.$(`${cohortSel} [data-testid="an-card-cohorts-warnings"]`);
ok(!!cohWarn, "23 the cohort card renders the service's own warnings");
const cohWarnTxt = cohWarn ? await cohWarn.innerText() : '';
for (const w of COH.meta.warnings) {
  ok(cohWarnTxt.includes(w.reason.slice(0, 40)), `23 …including the '${w.source}' one`);
}
ok(!cohWarnTxt.includes('[object Object]'), '23 …and none stringifies as [object Object]');

// A FAILED cohort read is not an empty cohort table.
ok(!!(await page.$('#state-insight-dead [data-testid="an-card-cohorts"] [data-testid="an-card-failed"]')),
  "23 a failed cohort read renders the couldn't-load well");
ok(!(await page.$('#state-insight-dead [data-testid="an-card-cohorts"] [data-testid="an-card-empty"]')),
  '23 …and NEVER "no new customers were acquired"');
ok(!!(await page.$('#state-insight-none [data-testid="an-card-cohorts"] [data-testid="an-card-empty"]')),
  '23 a SUCCEEDED read over a window with no acquisitions DOES render the empty state');

/* ── 24. the composite-fed cards nobody was drawing ──────────────────────── */

const wfSel = '#state-measured [data-testid="an-card-step-waterfall"]';
ok(!!(await page.$(wfSel)), '24 the step waterfall mounted');
ok(Array.isArray(DASH.waterfall.steps) && DASH.waterfall.steps.length > 0,
  `24 (capture) the composite carries ${DASH.waterfall.steps.length} steps`);
for (const st of DASH.waterfall.steps) {
  ok(!!(await page.$(`${wfSel} [data-testid="an-card-step-waterfall-step-${st.step}"]`)),
    `24 …the '${st.step}' step is drawn`);
}
const wfText = await textOf(wfSel);
ok(wfText.includes(int(DASH.waterfall.steps[0].visitors)),
  `24 …with the server's own visitor count (${int(DASH.waterfall.steps[0].visitors)})`);
const firstStep = DASH.waterfall.steps[0].step;
const entryCell = await trimOf(`${wfSel} [data-testid="an-card-step-waterfall-through-${firstStep}"]`);
eq(entryCell, 'entry',
  '24 …and the entry step says "entry", NOT "100% through" — 100% of nothing is a claim');
ok(wfText.includes('page VIEWS, not submits'),
  '24 …and the card states what it is NOT measuring');

const mvSel = '#state-measured [data-testid="an-card-movers"]';
ok(!!(await page.$(mvSel)), '24 the movers card mounted');
const mvText = await textOf(mvSel);
if ((DASH.movers || []).length > 0) {
  for (const m of DASH.movers) {
    ok(mvText.includes(money(Math.abs(m.delta))),
      `24 …the server's delta ${money(Math.abs(m.delta))} is printed`);
  }
} else {
  ok(mvText.includes('No funnel has a measured change'),
    '24 …with no movers in the capture, the card says why rather than going blank');
}
ok(mvText.includes('is NOT ranked'),
  '24 …and the card states that an unbaselined funnel is not ranked');

const ecSel = '#state-measured [data-testid="an-card-economics"]';
ok(!!(await page.$(ecSel)), '24 the unit-economics card mounted');
const ecText = await textOf(ecSel);
ok(ecText.includes('Cost coverage'), '24 …printing the cost-coverage figure that gates the rest');
ok(ecText.includes('no cost is'), '24 …and stating that it re-derives no cost');
const ecOrders = DASH.kpis.upsell_lines.orders ?? DASH.kpis.orders;
if (ecOrders && DASH.kpis.net_sales !== null) {
  ok(ecText.includes(money(DASH.kpis.net_sales / ecOrders)),
    `24 …and revenue/order is the server's net_sales ÷ orders (${money(DASH.kpis.net_sales / ecOrders)})`);
}

const tlSel = '#state-measured [data-testid="an-card-top-lists"]';
ok(!!(await page.$(tlSel)), '24 the top-lists card mounted');
ok(!!(await page.$(`${tlSel} [data-testid="an-card-top-lists-slice-campaigns"]`)),
  '24 …with a campaigns slice control');
const prodSub = await textOf(tlSel);
ok(prodSub.includes('Gross sales'),
  '24 …and the products slice captions itself GROSS (the metric that fold actually carries)');
// SWITCHING SLICES REALLY SWITCHES THE FOLD — clicked, not assumed.
await page.click(`${tlSel} [data-testid="an-card-top-lists-slice-campaigns"]`);
await page.waitForTimeout(200);
const campSub = await textOf(tlSel);
ok(campSub.includes('Net sales'),
  '24 …and the campaigns slice captions itself NET, because that fold carries a different metric');
ok(campSub.includes('Last-touch campaign'), '24 …naming the basis it is on');

const l60Sel = '#state-measured [data-testid="an-card-last-60"]';
ok(!!(await page.$(l60Sel)), '24 the last-60 card mounted');
const l60Text = await textOf(l60Sel);
ok(l60Text.includes('does not follow the date picker'),
  "24 …stating that its window is NOT the header's");
ok(l60Text.includes(INS.last_60.window.start) && l60Text.includes(INS.last_60.window.end),
  `24 …and printing the window it IS on (${INS.last_60.window.start} → ${INS.last_60.window.end})`);
const l60Measured = INS.last_60.series.filter((p) => p.net_sales !== null).length;
ok(l60Text.includes(`${l60Measured} of ${INS.last_60.series.length} days measured`),
  `24 …and admitting how many of its ${INS.last_60.series.length} buckets were measured (${l60Measured})`);

/* ── 25. the insight lane touched only its own API ───────────────────────── */

ok(served.insights >= 1, `25 the real route fetched the insight composite (${served.insights}x)`);
ok(served.cohorts >= 1, `25 …and the cohort table (${served.cohorts}x)`);
ok(!!(await page.$('#state-live [data-testid="an-insights-strip"]')),
  '25 the strip rendered end to end, from a real HTTP response');
ok(!!(await page.$('#state-live [data-testid="an-card-cohorts"]')),
  '25 …and so did the cohort card');

/* ── 26. THE PARTIAL (in-progress) DAY — the reviewer's fix, in the DOM ───── */

// The captured payload really is a partial day carrying no downward card.
eq(ISEED.insights_partial.partial, true, '26 (capture) the partial payload is flagged partial');
ok(!ISEED.insights_partial.insights.some((c) => c.direction === 'down'),
  '26 (capture) …and carries NOT ONE downward card');

const partialStrip = '#state-insight-partial [data-testid="an-insights-strip"]';
ok(!!(await page.$(partialStrip)), '26 the strip mounted on the partial-day state');
// THE LABEL. A short list on today must not read as "all clear" — the strip
// tells the operator the day is not over.
const partialLabel = await page.$(`${partialStrip} [data-testid="an-insights-strip-partial"]`);
ok(!!partialLabel, '26 the strip LABELS today "in progress"');
ok((await partialLabel.innerText()).toLowerCase().includes('in progress'),
  '26 …in those words');
// NOT ONE downward card in the rendered DOM (bad/warn cards that point down).
const partialSeverities = await page.$$eval(`${partialStrip} [data-severity]`,
  (els) => els.map((e) => e.getAttribute('data-severity')));
console.log(`      partial-day card severities in DOM: ${JSON.stringify(partialSeverities)}`);
// Every card the server sent survives (all up/neutral); the guarantee is that
// none is a downward alarm. Cross-check the DOM cards against the payload.
for (const c of ISEED.insights_partial.insights) {
  ok(!!(await page.$(`${partialStrip} [data-testid="an-insight-${c.kind}"]`)),
    `26 the surviving '${c.kind}' (${c.direction}) card is drawn`);
}
// The today_partial warning is on screen — the withholding is NAMED.
const partialNotes = await page.$(`${partialStrip} [data-testid="an-insights-strip-notes"]`);
const partialNotesTxt = partialNotes ? await partialNotes.innerText() : '';
ok(partialNotesTxt.toLowerCase().includes('in progress')
  || partialNotesTxt.toLowerCase().includes('withheld'),
  `26 the today_partial warning explains the withholding (${partialNotesTxt.slice(0, 80)})`);
// And it must NOT claim the settled "nothing stood out" — that sentence is only
// for a complete, fully-examined day.
ok(!(await textOf(partialStrip)).includes('Nothing stood out'),
  '26 …and the partial day NEVER prints the settled-day "nothing stood out" verdict');

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
