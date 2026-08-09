/**
 * explorerRuntime harness — the two non-React runtime pieces, driven with the
 * REAL response fixtures (tests/fixtures.mjs, shaped from the shipped services):
 *   • explorerApi's readers + the two-vocabulary error mapper
 *   • savedReportsStore against a stubbed and a HOSTILE localStorage
 *
 * Standalone: `node client/src/pages/analytics/explorer/tests/explorerRuntime.harness.mjs`
 * Both modules sit on the failure path of a surface that must degrade to "no
 * rows" rather than white-screen the analytics tab, so both are exercised DOWN
 * their failure paths here, not just their happy ones.
 */
import assert from 'node:assert/strict';
import { CLICKS, LANE1_REFUSAL, LANE2_REFUSAL, QUERY_ROWS, QUERY_SERIES, ROAS } from './fixtures.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  PASS  ${name}`); } catch (e) {
    fail += 1; failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`); }

/* A localStorage stub must exist BEFORE savedReportsStore is imported. */
function makeStorage({ throwOnGet = false, throwOnSet = false, seed = null } = {}) {
  let value = seed;
  return {
    getItem() { if (throwOnGet) throw new Error('SecurityError'); return value; },
    setItem(_k, v) { if (throwOnSet) throw new Error('QuotaExceededError'); value = v; },
    removeItem() { value = null; },
    peek() { return value; },
  };
}
globalThis.window = { localStorage: makeStorage() };

const {
  explorerApiError, foldByNetwork, readClicksResult, readQueryResult, readRoasResult,
} = await import('../explorerApi.js');
const store = await import('../savedReportsStore.js');

const GARBAGE = [null, undefined, 0, '', 'nope', [], NaN, true, { series: 'x' }, { rows: null }];

/* ══ 1. /query reader ════════════════════════════════════════════════ */
section('1. /query reader');

check('never throws; always returns arrays/objects', () => {
  GARBAGE.forEach((g, i) => {
    const r = readQueryResult(g);
    assert.equal(r.kind, 'query', `@${i}`);
    ['series', 'rows', 'prevSeries', 'prevRows', 'warnings'].forEach((k) => assert.ok(Array.isArray(r[k]), `${k} @${i}`));
    assert.equal(typeof r.totals, 'object', `@${i}`);
    assert.equal(r.hasPrevious, false, `@${i}`);
  });
});

check('reads previous.series — the ONE spelling runQuery emits', () => {
  const r = readQueryResult(QUERY_SERIES);
  assert.equal(r.series.length, 3);
  assert.equal(r.prevSeries.length, 3, 'previous.series was not read');
  assert.equal(r.prevSeries[0].gross_sales, 1100);
  assert.deepEqual(r.prevTotals, QUERY_SERIES.previous.totals);
  assert.equal(r.hasPrevious, true);
});

check('hasPrevious is DERIVED from what was read, not from the key', () => {
  assert.equal(readQueryResult({ previous: {} }).hasPrevious, false, 'an empty previous is no baseline');
  assert.equal(readQueryResult({ previous: { totals: {} } }).hasPrevious, false);
  assert.equal(readQueryResult({ previous: { totals: { orders: 2 } } }).hasPrevious, true);
  assert.equal(readQueryResult({ previous: { rows: [{ key: 'a' }] } }).hasPrevious, true);
});

check('the WINDOW and TIMEZONE come off meta, flagged as the server\'s', () => {
  const r = readQueryResult(QUERY_SERIES);
  assert.equal(r.timezone, 'Europe/Madrid');
  assert.deepEqual(
    { s: r.window.start_day, e: r.window.end_day, d: r.window.days, f: r.window.from_server },
    { s: '2026-08-06', e: '2026-08-08', d: 3, f: true },
  );
  assert.equal(readQueryResult({}).window.from_server, false, 'no echo ⇒ must not claim one');
});

check('basis_label and warnings ride through verbatim', () => {
  const r = readQueryResult(QUERY_ROWS);
  assert.match(r.basisLabel, /captured base only/);
  assert.deepEqual(r.warnings, []);
  const s = readQueryResult(QUERY_SERIES);
  assert.equal(s.warnings.length, 2);
  assert.equal(s.warnings[0].source, 'lb_touches');
});

check('a withheld bucket stays NULL through the reader', () => {
  const r = readQueryResult(QUERY_SERIES);
  assert.equal(r.series[1].sessions, null, 'a TTL-withheld session count must not become 0');
  assert.equal(r.series[1].conv_pct, null);
});

/* ══ 2. attribution readers ══════════════════════════════════════════ */
section('2. attribution readers');

check('roas: rows / totals / rows_total / row_cap read by their real names', () => {
  const r = readRoasResult(ROAS);
  assert.equal(r.kind, 'roas');
  assert.equal(r.rows.length, 4);
  assert.equal(r.rowsTotal, 9, 'the footer denominator must be the SERVER count, not rows.length');
  assert.equal(r.rowCap, true);
  assert.equal(r.dimension, 'network');
  assert.match(r.basisLabel, /captured base only/);
  assert.equal(r.totals.roas, 2.68);
});

check('roas: the window is the SERVER\'s (days-ending-today, not the picker)', () => {
  const r = readRoasResult(ROAS);
  assert.deepEqual(
    { s: r.window.start_day, e: r.window.end_day, f: r.window.from_server },
    { s: '2026-07-11', e: '2026-08-09', f: true },
  );
  assert.equal(r.timezone, 'Europe/Madrid');
});

check('roas: an unknown cost keeps cost/cpa/roas NULL', () => {
  const r = readRoasResult(ROAS);
  const direct = r.rows.find((x) => x.key === 'direct / none');
  assert.equal(direct.cost, null);
  assert.equal(direct.cpa, null);
  assert.equal(direct.roas, null);
  assert.equal(direct.cost_unknown_reason, 'no_signal');
});

check('roas: totals stay NULL when the server sends none', () => {
  assert.equal(readRoasResult({ rows: [] }).totals, null);
  GARBAGE.forEach((g) => assert.ok(Array.isArray(readRoasResult(g).rows)));
});

check('clicks: reads `rows` (the real key), not `clicks`', () => {
  const r = readClicksResult(CLICKS);
  assert.equal(r.kind, 'clicks');
  assert.equal(r.rows.length, 3, 'getClicks() returns {rows}, and nothing emits {clicks}');
  assert.equal(r.rows[0].time, '2026-08-09T21:30:00.000Z');
  assert.equal(r.rows[0].day, '2026-08-09');
  assert.equal(r.limit, 200);
  assert.equal(r.truncated, false);
  assert.equal(r.timezone, 'Europe/Madrid');
});

check('clicks: `clicks` survives only as a legacy alias', () => {
  assert.equal(readClicksResult({ clicks: [{ id: 1 }] }).rows.length, 1);
  GARBAGE.forEach((g) => assert.ok(Array.isArray(readClicksResult(g).rows)));
});

check('clicks: by_network is FOLDED client-side (the server sends none)', () => {
  const r = readClicksResult(CLICKS);
  assert.deepEqual(Object.keys(r.byNetwork).sort(), ['(none)', 'meta', 'tiktok']);
  assert.deepEqual(r.byNetwork.meta, { clicks: 1, converted: 1, bots: 0 });
  assert.deepEqual(r.byNetwork.tiktok, { clicks: 1, converted: 0, bots: 1 });
  assert.deepEqual(foldByNetwork(null), {});
  assert.deepEqual(foldByNetwork([{ network: '' }]), { '(none)': { clicks: 1, converted: 0, bots: 0 } });
});

/* ══ 3. error mapping ════════════════════════════════════════════════ */
section('3. error mapping (two server vocabularies)');

check('a Lane 2 refusal has NO prose — the code alone must become a sentence', () => {
  const msg = explorerApiError(LANE2_REFUSAL);
  assert.match(msg, /1 and 180 days/, `got: ${msg}`);
  assert.ok(!/invalid_days/.test(msg), 'the raw code must not be the whole message');
});

check('every Lane 2 code maps to a sentence', () => {
  ['invalid_days', 'invalid_limit', 'invalid_dimension', 'invalid_date',
    'invalid_date_format', 'to_before_from', 'window_too_large'].forEach((code) => {
    const msg = explorerApiError({ response: { status: 400, data: { error: code } } });
    assert.ok(msg && !msg.includes(code), `${code} -> ${msg}`);
    assert.ok(/[a-z] [a-z]/.test(msg), `${code} is not a sentence: ${msg}`);
  });
});

check('a Lane 1 refusal keeps the engine\'s own message alongside ours', () => {
  const msg = explorerApiError(LANE1_REFUSAL);
  assert.match(msg, /not measured by that group-by/);
  assert.match(msg, /spend are not defined for dimension/, 'the engine names the metric; keep it');
});

check('401 / 403 / 404 / 5xx each get their own copy', () => {
  assert.match(explorerApiError({ response: { status: 401, data: {} } }), /Not authorised/);
  assert.match(explorerApiError({ response: { status: 403, data: {} } }), /Not authorised/);
  assert.match(explorerApiError({ response: { status: 404, data: {} } }), /not deployed/);
  assert.match(explorerApiError({ response: { status: 500, data: {} } }), /bug, not your input/);
});

check('a network failure falls back and never throws', () => {
  assert.equal(explorerApiError(new Error('Network Error')), 'Query failed — try again.');
  assert.equal(explorerApiError(undefined, 'CSV export failed — try again.'), 'CSV export failed — try again.');
  GARBAGE.forEach((g) => assert.equal(typeof explorerApiError(g), 'string'));
});

/* ══ 4. saved reports store ══════════════════════════════════════════ */
section('4. saved reports store');

check('add / load / rename / remove round-trips and reports ok', () => {
  globalThis.window = { localStorage: makeStorage() };
  const e = store.addSavedReport('Net by funnel', { metrics: ['net_sales'] });
  assert.ok(e && e.id);
  assert.equal(store.loadSavedReports().length, 1);
  const renamed = store.renameSavedReport(e.id, 'Renamed');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.reports[0].name, 'Renamed');
  const removed = store.removeSavedReport(e.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.reports, []);
});

check('rename / remove report ok:false when the write did NOT land', () => {
  // Seed a readable list, then make writes fail — the UI must not show a change
  // that is not on disk.
  const s = makeStorage({ seed: '[{"id":"a","name":"One"}]' });
  s.setItem = () => { throw new Error('QuotaExceededError'); };
  globalThis.window = { localStorage: s };
  const r = store.renameSavedReport('a', 'Two');
  assert.equal(r.ok, false);
  assert.equal(r.reports[0].name, 'One', 'the list must stay as it is on disk');
  const d = store.removeSavedReport('a');
  assert.equal(d.ok, false);
  assert.equal(d.reports.length, 1);
});

check('a corrupt blob reads as "no saved reports", never a crash', () => {
  globalThis.window = { localStorage: makeStorage({ seed: '{not json' }) };
  assert.deepEqual(store.loadSavedReports(), []);
  globalThis.window = { localStorage: makeStorage({ seed: '{"a":1}' }) };
  assert.deepEqual(store.loadSavedReports(), []);
  globalThis.window = { localStorage: makeStorage({ seed: '[null,3,{"id":"x"},{"id":"y","name":"ok"}]' }) };
  assert.deepEqual(store.loadSavedReports().map((r) => r.id), ['y']);
});

check('a storage that THROWS on read degrades to empty', () => {
  globalThis.window = { localStorage: makeStorage({ throwOnGet: true }) };
  assert.deepEqual(store.loadSavedReports(), []);
});

check('a FULL storage returns null from addSavedReport', () => {
  globalThis.window = { localStorage: makeStorage({ throwOnSet: true }) };
  assert.equal(store.addSavedReport('x', {}), null);
});

check('no window / no localStorage at all is survivable', () => {
  globalThis.window = undefined;
  assert.deepEqual(store.loadSavedReports(), []);
  assert.equal(store.addSavedReport('x', {}), null);
  globalThis.window = {};
  assert.deepEqual(store.loadSavedReports(), []);
});

check('an empty rename is refused rather than blanking the chip', () => {
  globalThis.window = { localStorage: makeStorage() };
  const e = store.addSavedReport('Keep me', {});
  assert.equal(store.renameSavedReport(e.id, '   ').reports[0].name, 'Keep me');
});

check(`the cap keeps the NEWEST ${store.MAX_SAVED_REPORTS}, not the oldest`, () => {
  globalThis.window = { localStorage: makeStorage() };
  const total = store.MAX_SAVED_REPORTS + 10;
  for (let i = 0; i < total; i += 1) store.addSavedReport(`r${i}`, { n: i });
  const list = store.loadSavedReports();
  assert.equal(list.length, store.MAX_SAVED_REPORTS);
  // The one just saved MUST be there — dropping it made a save look successful
  // and vanish on reload.
  assert.equal(list[list.length - 1].name, `r${total - 1}`);
  assert.equal(list[0].name, `r${total - store.MAX_SAVED_REPORTS}`);
});

console.log(`\n${'═'.repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  • ${f}`));
  globalThis.process?.exit(1);
}
console.log('explorerRuntime harness green.');
