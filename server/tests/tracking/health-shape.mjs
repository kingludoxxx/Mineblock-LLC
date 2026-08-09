// Unit verification for the tracking-health classification
// (server/src/services/trackingHealth.js).
//
// The module is pure and dependency-free on purpose, so node can exercise it
// with fixture rows and no database. The cases that matter are the HONEST ones:
// a pixel with no traffic must never read as failing, a skip must never read as
// a failure, and an outage must read as an outage.
//
// Run:  node server/tests/tracking/health-shape.mjs
import { shapeTrackingHealth, classifyPixel, serverChannelReady, asObject, STATUS_RANK } from '../../src/services/trackingHealth.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const eq = (got, want, m) => ok(got === want, m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const FID = 'fnl_health_test';

const SPECS = {
  meta_pixel: { label: 'Meta', readySecret: 'capi_token', idField: 'pixel_id' },
  ga4: { label: 'Google Analytics 4', readySecret: 'api_secret', idField: 'measurement_id' },
  google_ads: { label: 'Google Ads', notActive: true, idOptional: true, idField: 'customer_id' },
};

const metaPixel = (over = {}) => ({
  id: 'px_meta1', kind: 'meta_pixel', pixel_id: '123456789', mode: 'hybrid',
  enabled: true, config: { capi_token: 'enc:tok' }, ...over,
});

const counts = (platform, h24, d7 = h24) => ([
  { platform, window: 'h24', ...{ sent: 0, failed: 0, skipped: 0, deduped: 0, queued: 0, ...h24 } },
  { platform, window: 'd7', ...{ sent: 0, failed: 0, skipped: 0, deduped: 0, queued: 0, ...d7 } },
]);

const shape = (args) => shapeTrackingHealth({ funnelId: FID, specs: SPECS, now: NOW, ...args });
const only = (args) => shape(args).pixels[0];

// ── T1 healthy: sends landed, nothing failed ────────────────────────────────
{
  const p = only({ pixels: [metaPixel()], counts: counts('meta', { sent: 42 }) });
  eq(p.status, 'healthy', 'T1 healthy: sends with no failures');
  eq(p.tone, 'success', 'T1 healthy: success tone');
  eq(p.windows.h24.sent, 42, 'T1 healthy: 24h sent count carried through');
  eq(p.breaker.state, 'closed', 'T1 healthy: breaker closed with no breaker row');
}

// ── T2 failing: activity, every attempt failed ──────────────────────────────
{
  const p = only({ pixels: [metaPixel()], counts: counts('meta', { failed: 7 }) });
  eq(p.status, 'failing', 'T2 failing: failed>0 and sent=0');
  eq(p.tone, 'danger', 'T2 failing: danger tone');
}

// ── T3 ZERO TRAFFIC — the headline rule: silence is NOT failure ─────────────
{
  const p = only({ pixels: [metaPixel()], counts: [] });
  eq(p.status, 'no_traffic', 'T3 zero traffic: no rows at all → no_traffic');
  ok(p.status !== 'failing', 'T3 zero traffic: never reads as failing');
  eq(p.tone, 'default', 'T3 zero traffic: neutral tone, not red');
  eq(p.windows.h24.sent, 0, 'T3 zero traffic: zeroed window, not undefined');
  eq(p.last_sent_at, null, 'T3 zero traffic: last_sent_at is null, not fabricated');
}
{
  // Quiet TODAY but delivered this week — still no_traffic in the 24h window,
  // with the 7d counters carrying the nuance. Must not read as healthy.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', {}, { sent: 900 }),
    lasts: [{ platform: 'meta', last_sent_at: '2026-08-06T09:00:00.000Z' }],
  });
  eq(p.status, 'no_traffic', 'T3b quiet 24h but busy 7d → no_traffic, not healthy');
  eq(p.windows.d7.sent, 900, 'T3b 7d counters still reported');
  eq(p.last_sent_at, '2026-08-06T09:00:00.000Z', 'T3b last delivered timestamp preserved');
}

// ── T4 BREAKER OPEN — an outage reads as an outage ──────────────────────────
{
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 3, failed: 12 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 5, open_until: '2026-08-09T12:10:00.000Z' }],
  });
  eq(p.status, 'outage', 'T4 breaker open → outage (outranks the counters)');
  eq(p.breaker.state, 'open', 'T4 breaker state reported open');
  eq(p.breaker.fails, 5, 'T4 breaker fail count carried');
}
{
  // An EXPIRED breaker window must not keep reading as an outage.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 10 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 5, open_until: '2026-08-09T11:00:00.000Z' }],
  });
  eq(p.status, 'healthy', 'T4b expired breaker → not an outage');
  eq(p.breaker.state, 'closed', 'T4b expired breaker reads closed');
}
{
  // Breaker keyed to a DIFFERENT pixel row must not bleed across pixels.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 5 }),
    breakers: [{ scope_id: `${FID}:px_other`, fails: 5, open_until: '2026-08-09T12:10:00.000Z' }],
  });
  eq(p.status, 'healthy', 'T4c another pixel\'s breaker does not leak into this one');
}

// ── T5 EMPTY FUNNEL ─────────────────────────────────────────────────────────
{
  const d = shape({ pixels: [], counts: [] });
  eq(d.pixels.length, 0, 'T5 empty funnel: no pixel rows');
  eq(d.overall, 'no_pixels', 'T5 empty funnel: overall is no_pixels, NOT healthy');
  ok(d.overall !== 'healthy', 'T5 empty funnel: never a green light over nothing');
  eq(d.totals_24h.sent, 0, 'T5 empty funnel: zeroed totals');
  ok(typeof d.generated_at === 'string', 'T5 empty funnel: still answers with a timestamp');
}

// ── T6 disabled / T7 dormant / T8 misconfigured ─────────────────────────────
{
  const p = only({ pixels: [metaPixel({ enabled: false })], counts: counts('meta', { sent: 5 }) });
  eq(p.status, 'disabled', 'T6 disabled pixel reads disabled, not healthy');
}
{
  const p = only({
    pixels: [{ id: 'px_g', kind: 'google_ads', pixel_id: '1234567890', mode: 's2s', enabled: true, config: {} }],
    counts: [],
  });
  eq(p.status, 'not_active', 'T7 registered-but-dormant kind reads not_active');
  eq(p.not_active, true, 'T7 not_active flag surfaced');
  eq(p.server_channel_ready, false, 'T7 dormant kind is never server_channel_ready');
}
{
  const p = only({ pixels: [metaPixel({ config: {} })], counts: [] });
  eq(p.status, 'misconfigured', 'T8 hybrid pixel with no CAPI token → misconfigured, not no_traffic');
  ok(Array.isArray(p.missing) && p.missing.includes('capi_token'), 'T8 names the missing credential', JSON.stringify(p.missing));
}
{
  // A NATIVE (browser-only) pixel must NOT be called misconfigured for lacking
  // a server credential — it was never going to use one.
  const p = only({ pixels: [metaPixel({ mode: 'native', config: {} })], counts: [] });
  eq(p.status, 'no_traffic', 'T8b native/browser-only pixel is not misconfigured for a missing server token');
}

// ── T9 degraded / T10 queue-backlog outage ──────────────────────────────────
{
  const p = only({ pixels: [metaPixel()], counts: counts('meta', { sent: 20, failed: 3 }) });
  eq(p.status, 'degraded', 'T9 partial failures → degraded');
}
{
  // NB the expectation here CHANGED with the precedence fix (see T16d): with a
  // live backlog present, failures + zero sends read as 'outage', not
  // 'failing' — the events are stranded but preserved for retry, which is both
  // more accurate and the more actionable message. 'failing' is now reserved
  // for failures with NO backlog (T2).
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { failed: 2 }),
    queueDepth: [{ kind: 'meta_pixel', n: 14 }],
  });
  eq(p.status, 'outage', 'T10a failures + live backlog + zero sends → outage');
  eq(p.queued_now, 14, 'T10a live queue depth carried');
}
{
  // Backlog with no logged failures and no sends — the breaker has not tripped
  // yet, but nothing is getting through. That is an outage.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { queued: 9 }),
    queueDepth: [{ kind: 'meta_pixel', n: 9 }],
  });
  eq(p.status, 'outage', 'T10b retry backlog with zero deliveries → outage');
}
{
  // REGRESSION (found by extras-e2e.mjs E7, missed here): a live queue backlog
  // with an ENTIRELY EMPTY ledger window. queuedNow comes from
  // lb_postback_queue while the window counts lb_tracking_events, so the two
  // diverge whenever events were queued before the window opened and are still
  // retrying. The original fixture above put the backlog in the LEDGER, a shape
  // the real system does not produce, so the zero-traffic branch short-circuited
  // ahead of the queue check and reported "no traffic" over stuck conversions.
  const p = only({
    pixels: [metaPixel()],
    counts: [],
    queueDepth: [{ kind: 'meta_pixel', n: 2 }],
  });
  eq(p.status, 'outage', 'T10c EMPTY ledger window + live queue backlog → outage, NOT no_traffic');
  eq(p.queued_now, 2, 'T10c live queue depth carried with an empty window');
  ok(p.status !== 'no_traffic', 'T10c never reports "no traffic" while events sit undelivered');
}
{
  // The complement: genuinely nothing anywhere is still no_traffic.
  const p = only({ pixels: [metaPixel()], counts: [], queueDepth: [] });
  eq(p.status, 'no_traffic', 'T10d empty ledger AND empty queue → no_traffic (unchanged)');
}

// ── T11 A SKIP IS NOT A FAILURE (and not a delivery either) ─────────────────
{
  const p = only({ pixels: [metaPixel()], counts: counts('meta', { skipped: 30 }) });
  ok(p.status !== 'failing', 'T11 skipped-only window never reads as failing');
  ok(p.status !== 'healthy', 'T11 skipped-only window never reads as healthy (nothing was sent)');
  eq(p.status, 'no_deliveries', 'T11 skipped-only window → no_deliveries');
  eq(p.windows.h24.skipped, 30, 'T11 skips reported in their own bucket, not folded into failed');
  eq(p.windows.h24.failed, 0, 'T11 skips do NOT increment the failed counter');
}
{
  const p = only({ pixels: [metaPixel()], counts: counts('meta', { sent: 12, skipped: 40 }) });
  eq(p.status, 'healthy', 'T11b skips alongside real sends do not degrade the verdict');
}

// ── T12 roll-up + sort + totals ─────────────────────────────────────────────
{
  const d = shape({
    pixels: [metaPixel(), { id: 'px_ga', kind: 'ga4', pixel_id: 'G-ABCD1234', mode: 's2s', enabled: true, config: { api_secret: 'enc:s' } }],
    counts: [...counts('meta', { sent: 100 }), ...counts('ga4', { failed: 5 })],
  });
  eq(d.overall, 'failing', 'T12 roll-up takes the WORST pixel, not the average');
  eq(d.pixels[0].kind, 'ga4', 'T12 worst pixel sorts first');
  eq(d.totals_24h.sent, 100, 'T12 totals sum across pixels');
  eq(d.totals_24h.failed, 5, 'T12 totals sum failures across pixels');
  eq(d.pixels[1].id_field, 'pixel_id', 'T12 meta uses pixel_id as its identity label');
  eq(d.pixels[0].id_field, 'measurement_id', 'T12 GA4 uses measurement_id, never "pixel_id"');
}

// ── T13 degraded inputs must not crash (jsonb both shapes, junk rows) ───────
{
  // config arriving as a double-encoded STRING (the jsonb trap) must still be read.
  const p = only({ pixels: [metaPixel({ config: '{"capi_token":"enc:tok"}' })], counts: counts('meta', { sent: 1 }) });
  eq(p.status, 'healthy', 'T13a config as a JSON STRING is parsed, not treated as missing');
}
{
  const p = only({ pixels: [metaPixel({ config: 'not json at all' })], counts: [] });
  eq(p.status, 'misconfigured', 'T13b unparseable config degrades to "no secret", never throws');
}
eq(JSON.stringify(asObject(null)), '{}', 'T13c asObject(null) → {}');
eq(JSON.stringify(asObject('[1,2]')), '{}', 'T13d asObject of a JSON array → {} (arrays are not configs)');
eq(JSON.stringify(asObject({ a: 1 })), '{"a":1}', 'T13e asObject passes objects through');
{
  // Null/garbage counters and a null breaker timestamp must not produce NaN.
  const p = only({
    pixels: [metaPixel()],
    counts: [{ platform: 'meta', window: 'h24', sent: null, failed: undefined, skipped: 'x', deduped: 3, queued: null }],
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: null, open_until: null }],
  });
  ok(!Number.isNaN(p.windows.h24.sent), 'T13f null counters coerce to 0, never NaN');
  eq(p.windows.h24.sent, 0, 'T13g null sent → 0');
  eq(p.windows.h24.skipped, 0, 'T13h non-numeric skipped → 0');
  eq(p.breaker.fails, 0, 'T13i null breaker fails → 0');
  eq(p.breaker.state, 'closed', 'T13j null open_until → closed, not open');
}
{
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 1 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 2, open_until: 'not-a-date' }],
  });
  eq(p.breaker.state, 'closed', 'T13k unparseable open_until does not fake an outage');
}
{
  // A pixel whose kind is not in the registry at all — no spec, must not throw.
  const p = only({ pixels: [{ id: 'px_x', kind: 'mystery_net', pixel_id: 'z', mode: 'native', enabled: true, config: {} }], counts: [] });
  eq(p.status, 'no_traffic', 'T13l unknown kind with no spec still classifies');
  eq(p.label, 'mystery_net', 'T13m unknown kind falls back to its raw name');
}

// ── T14 direct classifier + serverChannelReady contract ─────────────────────
eq(classifyPixel({ pixel: metaPixel(), spec: SPECS.meta_pixel, h24: { sent: 0, failed: 0, skipped: 0, deduped: 0, queued: 0 }, breakerOpen: false, queuedNow: 0 }).status,
  'no_traffic', 'T14a classifyPixel is callable standalone');
eq(serverChannelReady(metaPixel(), SPECS.meta_pixel), true, 'T14b hybrid + token + id → ready');
eq(serverChannelReady(metaPixel({ mode: 'native' }), SPECS.meta_pixel), false, 'T14c native mode is not a server channel');
eq(serverChannelReady(metaPixel({ config: {} }), SPECS.meta_pixel), false, 'T14d missing secret → not ready');
eq(serverChannelReady(metaPixel({ pixel_id: '' }), SPECS.meta_pixel), false, 'T14e missing id → not ready');

// ── T16 PRECEDENCE: measured failure OUTRANKS a config prediction ───────────
// Regression for the review's reproduced probes. `misconfigured` used to sit
// ahead of failing/outage, so a pixel drowning in real failures rendered as a
// calm amber "Not ready" instead of red.
{
  // T16a: misconfigured (no token) AND 500 conversions stranded in the queue.
  const p = only({
    pixels: [metaPixel({ config: {} })],
    counts: counts('meta', {}),
    queueDepth: [{ kind: 'meta_pixel', n: 500 }],
  });
  eq(p.status, 'outage', 'T16a misconfigured + stuck queue → outage (red), NOT misconfigured');
  eq(p.tone, 'danger', 'T16a renders red, not amber');
  eq(p.queued_now, 500, 'T16a stranded count carried');
}
{
  // T16b: misconfigured (no token) AND 400 failed sends.
  const p = only({
    pixels: [metaPixel({ config: {} })],
    counts: counts('meta', { failed: 400 }),
  });
  eq(p.status, 'failing', 'T16b misconfigured + failed sends → failing (red), NOT misconfigured');
  eq(p.tone, 'danger', 'T16b renders red, not amber');
}
{
  // T16c: the branch must still fire when there is NO contradicting evidence.
  const p = only({ pixels: [metaPixel({ config: {} })], counts: [] });
  eq(p.status, 'misconfigured', 'T16c misconfigured still wins over no_traffic (unchanged)');
}
{
  // T16d: failures AND a backlog with zero sends → outage outranks failing,
  // because the events are preserved for retry and that is the actionable read.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { failed: 9 }),
    queueDepth: [{ kind: 'meta_pixel', n: 4 }],
  });
  eq(p.status, 'outage', 'T16d failed + backlog + zero sends → outage, not failing');
}
{
  // T16e: an open breaker still outranks everything below it.
  const p = only({
    pixels: [metaPixel({ config: {} })],
    counts: counts('meta', { failed: 50 }),
    queueDepth: [{ kind: 'meta_pixel', n: 50 }],
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 5, open_until: '2026-08-09T12:10:00.000Z' }],
  });
  eq(p.status, 'outage', 'T16e open breaker still wins');
  eq(p.breaker.state, 'open', 'T16e breaker reported open');
}
{
  // T16f: severity ranks must agree with the branch order, or the funnel
  // roll-up would disagree with the per-pixel verdicts.
  ok(STATUS_RANK.outage > STATUS_RANK.failing, 'T16f rank: outage > failing');
  ok(STATUS_RANK.failing > STATUS_RANK.misconfigured, 'T16f rank: failing > misconfigured');
  ok(STATUS_RANK.misconfigured > STATUS_RANK.degraded, 'T16f rank: misconfigured > degraded');
  ok(STATUS_RANK.degraded > STATUS_RANK.no_traffic, 'T16f rank: degraded > no_traffic');
  ok(STATUS_RANK.no_traffic > STATUS_RANK.healthy, 'T16f rank: no_traffic > healthy');
}

// ── T17 BREAKER COPY — the lapsed-cooldown contradiction (review m6) ────────
{
  // Open: note states the open state and the fail count.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 1 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 6, open_until: '2026-08-09T12:10:00.000Z' }],
  });
  eq(p.breaker.cooldown_lapsed, false, 'T17a an OPEN breaker is not "cooldown lapsed"');
  eq(p.breaker.note,
    'Circuit breaker open after 6 consecutive endpoint failures — events are queued, not sent.',
    'T17a open copy');
}
{
  // THE CONTRADICTION: fails >= threshold but the cooldown has elapsed. The old
  // copy said "7 consecutive failures — the breaker opens at 5" beside a
  // 'closed' state.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 3 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 7, open_until: '2026-08-09T11:00:00.000Z' }],
  });
  eq(p.breaker.state, 'closed', 'T17b lapsed cooldown reads closed');
  eq(p.breaker.cooldown_lapsed, true, 'T17b cooldown_lapsed flagged');
  eq(p.breaker.note, 'Cooldown lapsed after 7 consecutive failures — delivery is retrying.', 'T17b lapsed copy');
  ok(!/opens at/.test(p.breaker.note), 'T17b copy no longer claims "the breaker opens at 5" while closed');
}
{
  // Below the threshold, never opened: the "opens at N" copy is correct here.
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 3 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 2, open_until: null }],
  });
  eq(p.breaker.cooldown_lapsed, false, 'T17c below threshold is not lapsed');
  eq(p.breaker.note, '2 consecutive failures recorded — the breaker opens at 5.', 'T17c approaching-threshold copy');
}
{
  const p = only({
    pixels: [metaPixel()],
    counts: counts('meta', { sent: 3 }),
    breakers: [{ scope_id: `${FID}:px_meta1`, fails: 1, open_until: null }],
  });
  eq(p.breaker.note, '1 consecutive failure recorded — the breaker opens at 5.', 'T17d singular grammar');
}
{
  const p = only({ pixels: [metaPixel()], counts: counts('meta', { sent: 3 }) });
  eq(p.breaker.note, null, 'T17e a clean breaker emits NO note (nothing to explain)');
  eq(p.breaker.cooldown_lapsed, false, 'T17e clean breaker not lapsed');
}

// ── T18 TOTALS: ledger sum vs instantaneous gauge (review M3) ───────────────
{
  const d = shape({
    pixels: [metaPixel(), { id: 'px_ga', kind: 'ga4', pixel_id: 'G-ABCD1234', mode: 's2s', enabled: true, config: { api_secret: 'enc:s' } }],
    counts: [...counts('meta', { sent: 10, queued: 4 }), ...counts('ga4', { sent: 5, queued: 1 })],
    queueDepth: [{ kind: 'meta_pixel', n: 7 }, { kind: 'ga4', n: 2 }],
  });
  eq(d.totals_24h.queued, 5, 'T18a totals_24h.queued is the LEDGER sum (4+1)');
  eq(d.queued_now, 9, 'T18b queued_now is the LIVE depth (7+2), reported separately');
  eq(d.totals_24h.queued_now, undefined, 'T18c the live gauge is NOT inside totals_24h');
  eq(d.totals_24h.sent, 15, 'T18d ledger sums unaffected');
}

// ── T15 no-argument call must not throw ─────────────────────────────────────
{
  let threw = false;
  let d = null;
  try { d = shapeTrackingHealth(); } catch { threw = true; }
  ok(!threw, 'T15 shapeTrackingHealth() with NO arguments does not throw');
  eq(d && d.overall, 'no_pixels', 'T15 empty call reports no_pixels');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
