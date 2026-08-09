/**
 * explorerRuntime harness — the two non-React runtime pieces:
 *   • explorerApi's shape-tolerant response readers + error mapper
 *   • savedReportsStore against a stubbed (and a HOSTILE) localStorage
 *
 * Standalone: `node client/src/pages/analytics/explorer/tests/explorerRuntime.harness.mjs`
 * Both modules are on the failure path of a surface that must degrade to "no
 * rows" instead of white-screening the analytics tab, so both are exercised
 * DOWN their failure paths here, not just their happy ones.
 */
import assert from 'node:assert/strict';

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

/* A localStorage stub must exist BEFORE savedReportsStore is imported, because
   the module reads window.localStorage lazily but the harness calls it early. */
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
  explorerApiError, readClicksResult, readQueryResult, readRoasResult,
} = await import('../explorerApi.js');
const store = await import('../savedReportsStore.js');

/* ══ 1. response readers ═════════════════════════════════════════════ */
section('1. shape-tolerant readers');

const GARBAGE = [null, undefined, 0, '', 'nope', [], NaN, true, { series: 'x' }, { rows: null }];

check('readQueryResult never throws and always returns arrays/objects', () => {
  GARBAGE.forEach((g, i) => {
    const r = readQueryResult(g);
    assert.ok(Array.isArray(r.series) && Array.isArray(r.rows) && Array.isArray(r.prevSeries), `@${i}`);
    assert.equal(typeof r.totals, 'object', `@${i}`);
    assert.equal(r.hasPrevious, false, `@${i}`);
  });
});

check('readQueryResult reads the documented /query shape', () => {
  const r = readQueryResult({
    series: [{ key: '2026-08-01', orders: 3 }],
    totals: { orders: 3 },
    previous: { totals: { orders: 2 } },
    prev_series: [{ key: '2026-07-02', orders: 2 }],
    meta: { computed_ms: 42, basis: 'gross', basis_label: 'gross sales', warnings: ['sessions_unknown'] },
  });
  assert.equal(r.series.length, 1);
  assert.equal(r.prevSeries.length, 1);
  assert.deepEqual(r.prevTotals, { orders: 2 });
  assert.equal(r.hasPrevious, true);
  assert.equal(r.meta.computed_ms, 42);
  assert.deepEqual(r.meta.warnings, ['sessions_unknown']);
});

check('readQueryResult also accepts previous.series (the composite spelling)', () => {
  const r = readQueryResult({ previous: { series: [{ key: 'a', orders: 1 }], totals: {} } });
  assert.equal(r.prevSeries.length, 1);
  assert.equal(r.hasPrevious, true);
});

check('compare with NO previous block yields no baseline, not a zero one', () => {
  const r = readQueryResult({ series: [{ key: 'a', orders: 1 }], totals: { orders: 1 } });
  assert.equal(r.hasPrevious, false);
  assert.deepEqual(r.prevTotals, {});
  assert.deepEqual(r.prevSeries, []);
});

check('readRoasResult keeps totals NULL when the server sends none', () => {
  assert.equal(readRoasResult({ rows: [] }).totals, null);
  assert.deepEqual(readRoasResult({ rows: [], totals: { clicks: 1 } }).totals, { clicks: 1 });
  GARBAGE.forEach((g) => assert.ok(Array.isArray(readRoasResult(g).rows)));
});

check('readClicksResult accepts clicks[] or rows[] and never throws', () => {
  assert.equal(readClicksResult({ clicks: [{ id: 1 }] }).clicks.length, 1);
  assert.equal(readClicksResult({ rows: [{ id: 1 }, { id: 2 }] }).clicks.length, 2);
  GARBAGE.forEach((g) => assert.ok(Array.isArray(readClicksResult(g).clicks)));
});

/* ══ 2. error mapping — the failure path ═════════════════════════════ */
section('2. error mapping');

check('a 422 surfaces the engine message verbatim', () => {
  const msg = explorerApiError({ response: { status: 422, data: { detail: 'sessions is not measured by product' } } });
  assert.match(msg, /sessions is not measured by product/);
});

check('a 422 with no body still names the cause', () => {
  assert.match(explorerApiError({ response: { status: 422, data: {} } }), /combination/);
});

check('401 / 403 / 404 each get their own copy', () => {
  assert.match(explorerApiError({ response: { status: 401, data: {} } }), /Not authorised/);
  assert.match(explorerApiError({ response: { status: 403, data: {} } }), /Not authorised/);
  assert.match(explorerApiError({ response: { status: 404, data: {} } }), /not deployed/);
});

check('a network failure (no response at all) falls back, never throws', () => {
  assert.equal(explorerApiError(new Error('Network Error')), 'Query failed — try again.');
  assert.equal(explorerApiError(undefined, 'CSV export failed — try again.'), 'CSV export failed — try again.');
  assert.equal(explorerApiError({ response: { status: 500, data: 'boom' } }), 'boom');
});

/* ══ 3. saved reports store ══════════════════════════════════════════ */
section('3. saved reports store');

check('add / load / rename / remove round-trips', () => {
  globalThis.window = { localStorage: makeStorage() };
  const e = store.addSavedReport('Net by funnel', { metrics: ['net_sales'] });
  assert.ok(e && e.id);
  assert.equal(store.loadSavedReports().length, 1);
  assert.equal(store.renameSavedReport(e.id, 'Renamed')[0].name, 'Renamed');
  assert.deepEqual(store.removeSavedReport(e.id), []);
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

check('a FULL storage returns null from addSavedReport (the UI must say so)', () => {
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
  assert.equal(store.renameSavedReport(e.id, '   ')[0].name, 'Keep me');
});

check(`the list is capped at ${store.MAX_SAVED_REPORTS}`, () => {
  globalThis.window = { localStorage: makeStorage() };
  for (let i = 0; i < store.MAX_SAVED_REPORTS + 10; i += 1) store.addSavedReport(`r${i}`, {});
  assert.equal(store.loadSavedReports().length, store.MAX_SAVED_REPORTS);
});

console.log(`\n${'═'.repeat(64)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('explorerRuntime harness green.');
