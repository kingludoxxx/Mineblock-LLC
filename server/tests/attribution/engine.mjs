// ATTRIBUTION ENGINE verification (LANE 2) — drives the REAL
// funnelAttribution.js (getMarketing / getRoas / getClicks / getSpendDaily)
// and the REAL router against embedded PG. Proves by execution:
//
//   1. THE STITCH — the last touch BEFORE payment wins; a click after paid_at
//      never re-attributes a closed order; a stamped click beats a later
//      unstamped one; a bot click never attributes.
//   2. 'direct / none' and '(not set)' are DIFFERENT rows (nothing measured vs
//      visit seen but untagged).
//   3. Every breakdown names its basis (captured_base) + basis_label.
//   4. Totals fold EVERY bucket, not the returned page ("Top N of M · $total").
//   5. COST — all four cost_source branches (meta_api / pin_manual / ledger /
//      unknown), plus pin_ambiguous and api_by_campaign_only refusals.
//      Unknown cost ⇒ cost/roas/cpa null. Never Infinity, never 0.
//   6. Bot clicks are excluded from conversions and VISIBLE in the ledger.
//   7. Cross-network revenue dedup: per-group full, window total counted once.
//   8. TIMEZONE (operator decision, REPORT_TZ=Europe/Madrid): a 23:30Z
//      conversion lands on the NEXT Madrid day and divides THAT day's spend.
//   9. DST — the 25-hour day (2026-10-25) and the 23-hour day (2026-03-29)
//      bucket correctly, with no hardcoded offset anywhere.
//  10. Zero-click / zero-spend / empty window: no division by zero, no NaN,
//      no Infinity; unknown spend is null, never 0.
//  11. Malformed input is refused (dimension, limit, days, dates, window size).
//  12. The REAL router mounts, 401s without a token and serves with one.
//
// Run:  node server/tests/attribution/engine.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_attribution_engine';
const PORT = 48931;

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_attribution_engine`;
await admin`CREATE DATABASE puure_attribution_engine`;
await admin.end();

Object.assign(process.env, {
  DATABASE_URL: DB,
  NODE_ENV: 'development',
  PORT: String(PORT),
  JWT_ACCESS_SECRET: 'localdev',
  JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1',
  TRACKING_SWEEPS_DISABLED: '1',
  DOMAIN_SWEEP_DISABLED: '1',
});

const sql = postgres(DB, { ssl: false, onnotice: () => {} });

const svc = await import('../../src/services/funnelAttribution.js');
const {
  getMarketing, getRoas, getClicks, getSpendDaily,
  resolveKeys, resolveCost, resolveWindow, dayKeyInTz, shiftDay,
  REPORT_TZ, DIRECT_KEY, NOT_SET_KEY, BASIS, MARKETING_DIMENSIONS,
} = svc;
const { closeAnalyticsPool } = await import('../../src/services/analyticsDb.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
const { ensureTables: ensureFunnelTables } = await import('../../src/routes/funnels.js');
await ensureCheckoutTables();
await ensureTrackingTables();
await ensureFunnelCostsTables();
await ensureFunnelTables();

ok(REPORT_TZ === 'Europe/Madrid', 'setup REPORT_TZ defaults to Europe/Madrid', REPORT_TZ);

// ── fixtures ───────────────────────────────────────────────────────────────
const F1 = 'fnl_attr_alpha';
const F2 = 'fnl_attr_beta';
const FPIN = 'fnl_attr_pin';
const FAMB = 'fnl_attr_amb';
await sql`INSERT INTO funnels (id, slug, name) VALUES
  (${F1},'attr-alpha','Attr Alpha'), (${F2},'attr-beta','Attr Beta'),
  (${FPIN},'attr-pin','Attr Pin'), (${FAMB},'attr-amb','Attr Amb')`;

const session = (id, { funnel = F1, vid = null, paid, total = 100, status = 'paid' } = {}) =>
  sql.unsafe(
    `INSERT INTO co_sessions (id, funnel_id, vid, status, total, currency, paid_at, created_at)
     VALUES ($1,$2,$3,$4,$5,'USD',$6,$6)`,
    [id, funnel, vid, status, String(total), paid]
  );

let clickSeq = 0;
const click = (id, {
  funnel = F1, vid = 'v_none', network = 'meta', clickId = null, campaign = null,
  utm = {}, subs = {}, cpc = null, bot = false, ts, converted = false, sessionId = '',
  landing = '', country = '', device = '',
} = {}) => sql.unsafe(
  `INSERT INTO lb_clicks (id, funnel_id, vid, network, click_key, click_id, struct, subs, utm,
                          cpc, country, device, bot, landing_url, first_seen, last_seen, ts,
                          converted, session_id, expires_at)
   VALUES ($1,$2,$3,$4,'fbclid',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14,$15,$16,
           $14::timestamptz + INTERVAL '90 days')`,
  [
    id, funnel, vid, network, clickId || `cid_${(clickSeq += 1)}`,
    // Objects, NOT JSON.stringify: postgres.js serializes an object into jsonb,
    // and a pre-stringified value lands as a jsonb STRING SCALAR whose ->>'k'
    // is null (the same shape trackingClicks.recordClick writes).
    campaign ? { campaign_id: campaign } : {},
    subs, utm,
    cpc === null ? null : String(cpc), country, device, bot, landing, ts, converted, sessionId,
  ]
);

const touch = (vid, { funnel = F1, utm = {}, referrer = '', url = 'https://shop.test/lp', ts } = {}) =>
  sql.unsafe(
    `INSERT INTO lb_touches (vid, funnel_id, url, referrer, utm, ts, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6::timestamptz + INTERVAL '90 days')`,
    [vid, funnel, url, referrer, utm, ts]
  );

const metaSpend = (cid, day, spend) => sql.unsafe(
  `INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend) VALUES ('meta',$1,$2,$3)
   ON CONFLICT (source, ref_id, day) DO UPDATE SET spend = EXCLUDED.spend`,
  [cid, day, String(spend)]
);
const manualSpend = (fid, day, spend) => sql.unsafe(
  `INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend) VALUES ('manual',$1,$2,$3)
   ON CONFLICT (source, ref_id, day) DO UPDATE SET spend = EXCLUDED.spend`,
  [fid, day, String(spend)]
);
const pin = (cid, fid) => sql.unsafe(
  `INSERT INTO lb_campaign_map (campaign_id, funnel_id) VALUES ($1,$2)
   ON CONFLICT (campaign_id) DO UPDATE SET funnel_id = EXCLUDED.funnel_id`,
  [cid, fid]
);

const finite = (v) => v === null || (Number.isFinite(v) && !Number.isNaN(v));
const rowBy = (rows, key) => rows.find((r) => r.key === key) || null;

// ═══ T0: PURE — resolveKeys branches, no database ══════════════════════════
{
  const none = resolveKeys({});
  ok(none.campaign === DIRECT_KEY && none.source === DIRECT_KEY && none.referrer === DIRECT_KEY,
    'T0 no click and no touch → every key is "direct / none"', JSON.stringify(none));
  const seenUntagged = resolveKeys({ has_touch: true, touch_utm: {}, touch_url: 'https://s.test/lp' });
  ok(seenUntagged.campaign === NOT_SET_KEY,
    'T0 visit seen but untagged → "(not set)", NOT "direct / none"', seenUntagged.campaign);
  ok(seenUntagged.landing_page === 's.test/lp',
    'T0 landing page keys on host+path, query dropped', seenUntagged.landing_page);
  ok(seenUntagged.referrer === DIRECT_KEY,
    'T0 blank referrer with a visit IS "direct / none" (nothing referred them)');
  const full = resolveKeys({
    has_click: true, network: 'meta',
    click_utm: { utm_campaign: 'summer', utm_source: 'fb' },
    click_struct: { campaign_id: '123' },
    landing_url: 'https://s.test/lp?fbclid=x',
    has_touch: true, referrer: 'https://news.test/article/9',
  });
  ok(full.campaign === 'summer' && full.source === 'fb' && full.referrer === 'news.test'
    && full.landing_page === 's.test/lp', 'T0 utm wins, referrer reduces to host, query stripped',
  JSON.stringify(full));
  const structOnly = resolveKeys({ has_click: true, network: 'meta', click_struct: { campaign_id: '99' } });
  ok(structOnly.campaign === '99' && structOnly.source === 'meta',
    'T0 no utm → struct.campaign_id, then the network names the source');
}

// ═══ T1: THE STITCH — last touch BEFORE payment ════════════════════════════
{
  await session('s_stitch', { vid: 'v_stitch', paid: '2026-06-10T12:00:00Z', total: 100 });
  await click('c_old', { vid: 'v_stitch', campaign: 'old', ts: '2026-06-09T09:00:00Z' });
  await click('c_win', { vid: 'v_stitch', campaign: 'winner', ts: '2026-06-10T11:00:00Z' });
  // A click AFTER the purchase cannot have caused it.
  await click('c_after', { vid: 'v_stitch', campaign: 'after', ts: '2026-06-10T13:00:00Z' });

  const r = await getMarketing({ start: '2026-06-10', end: '2026-06-10', funnelId: F1, dimension: 'campaign' });
  ok(r.rows.length === 1 && r.rows[0].key === 'winner',
    'T1 the LATEST click at or before paid_at wins', JSON.stringify(r.rows));
  ok(!r.rows.some((x) => x.key === 'after'),
    'T1 a click AFTER paid_at never re-attributes a closed order');

  // Stamped click beats a later unstamped one — a stronger identity than vid.
  await session('s_stamp', { vid: 'v_stamp', paid: '2026-06-11T12:00:00Z', total: 50 });
  await click('c_stamped', { vid: 'v_stamp', campaign: 'stamped', ts: '2026-06-11T08:00:00Z', sessionId: 's_stamp' });
  await click('c_later', { vid: 'v_stamp', campaign: 'later', ts: '2026-06-11T10:00:00Z' });
  const rs = await getMarketing({ start: '2026-06-11', end: '2026-06-11', funnelId: F1, dimension: 'campaign' });
  ok(rs.rows.length === 1 && rs.rows[0].key === 'stamped',
    'T1 the STAMPED click (exact click-id match) beats a later vid-only click', JSON.stringify(rs.rows));

  // A bot click must never attribute — the touch behind it does.
  await session('s_bot', { vid: 'v_bot', paid: '2026-06-12T12:00:00Z', total: 70 });
  await click('c_bot', { vid: 'v_bot', campaign: 'botfarm', ts: '2026-06-12T09:00:00Z', bot: true });
  await touch('v_bot', { utm: { utm_campaign: 'organic-newsletter' }, ts: '2026-06-12T08:00:00Z' });
  const rb = await getMarketing({ start: '2026-06-12', end: '2026-06-12', funnelId: F1, dimension: 'campaign' });
  ok(rb.rows.length === 1 && rb.rows[0].key === 'organic-newsletter',
    'T1 a BOT click never attributes; the touch behind it does', JSON.stringify(rb.rows));
}

// ═══ T2: 'direct / none' vs '(not set)' are different facts ════════════════
{
  await session('s_dark', { funnel: F2, vid: null, paid: '2026-06-13T12:00:00Z', total: 40 });
  await session('s_untagged', { funnel: F2, vid: 'v_untag', paid: '2026-06-13T13:00:00Z', total: 60 });
  await touch('v_untag', { funnel: F2, utm: {}, url: 'https://shop.test/offer', ts: '2026-06-13T12:30:00Z' });

  const r = await getMarketing({ start: '2026-06-13', end: '2026-06-13', funnelId: F2, dimension: 'campaign' });
  const direct = rowBy(r.rows, DIRECT_KEY);
  const notSet = rowBy(r.rows, NOT_SET_KEY);
  ok(direct && notSet, 'T2 nothing-measured and seen-but-untagged are SEPARATE rows',
    JSON.stringify(r.rows.map((x) => x.key)));
  ok(direct.sales === 40 && notSet.sales === 60, 'T2 …and each carries its own money');
  ok(direct.is_unattributed === true && notSet.is_unattributed === true,
    'T2 both are flagged is_unattributed so a card can label them honestly');
  const land = await getMarketing({ start: '2026-06-13', end: '2026-06-13', funnelId: F2, dimension: 'landing_page' });
  ok(rowBy(land.rows, 'shop.test/offer')?.sales === 60,
    'T2 landing_page keys off the touch url', JSON.stringify(land.rows.map((x) => x.key)));
}

// ═══ T3: every breakdown names its basis ═══════════════════════════════════
{
  for (const dim of MARKETING_DIMENSIONS) {
    const r = await getMarketing({ start: '2026-06-10', end: '2026-06-13', dimension: dim });
    ok(r.basis === BASIS && typeof r.basis_label === 'string' && r.basis_label.length > 20,
      `T3 ${dim} breakdown names its basis + basis_label`, `${r.basis} / ${r.basis_label}`);
  }
  const r = await getMarketing({ start: '2026-06-10', end: '2026-06-13', dimension: 'nope' });
  ok(r.error === 'invalid_dimension', 'T3 an unknown dimension is REFUSED before any query', JSON.stringify(r));
}

// ═══ T4: totals fold EVERY bucket, not the page ════════════════════════════
{
  for (let i = 1; i <= 5; i += 1) {
    await session(`s_fold_${i}`, { funnel: F2, vid: `v_fold_${i}`, paid: '2026-06-20T12:00:00Z', total: i * 10 });
    await click(`c_fold_${i}`, { funnel: F2, vid: `v_fold_${i}`, campaign: `cmp_${i}`, ts: '2026-06-20T10:00:00Z' });
  }
  const r = await getMarketing({ start: '2026-06-20', end: '2026-06-20', funnelId: F2, dimension: 'campaign', limit: 2 });
  ok(r.rows.length === 2, 'T4 the page is capped at limit', String(r.rows.length));
  ok(r.totals.rows_total === 5, 'T4 rows_total counts EVERY bucket', String(r.totals.rows_total));
  ok(r.totals.sales === 150, 'T4 totals.sales folds the tail the page threw away', String(r.totals.sales));
  ok(r.totals.orders === 5, 'T4 totals.orders folds every bucket too', String(r.totals.orders));
  ok(r.rows[0].key === 'cmp_5' && r.rows[0].bar_pct === 100,
    'T4 rows are ranked richest-first and the leader sets the bar scale', JSON.stringify(r.rows[0]));
  ok(r.rows[1].bar_pct === 80, 'T4 bars are drawn against the leader', String(r.rows[1].bar_pct));
}

// ═══ T5: TIMEZONE — 23:30Z lands on the NEXT Madrid day ════════════════════
{
  // 2026-08-09T23:30Z = 2026-08-10 01:30 in Madrid (CEST, UTC+2).
  await session('s_tz', { funnel: FPIN, vid: 'v_tz', paid: '2026-08-09T23:30:00Z', total: 200 });
  await click('c_tz', { funnel: FPIN, vid: 'v_tz', campaign: 'tzcamp', ts: '2026-08-09T20:00:00Z' });

  const d9 = await getMarketing({ start: '2026-08-09', end: '2026-08-09', funnelId: FPIN, dimension: 'campaign' });
  const d10 = await getMarketing({ start: '2026-08-10', end: '2026-08-10', funnelId: FPIN, dimension: 'campaign' });
  ok(d9.totals.orders === 0, 'T5 a 23:30Z order is NOT on the 09th (that is a UTC day, not a Madrid day)',
    JSON.stringify(d9.totals));
  ok(d10.totals.orders === 1 && d10.totals.sales === 200,
    'T5 …it lands on the NEXT Madrid day, the 10th', JSON.stringify(d10.totals));
  ok(d10.window.timezone === 'Europe/Madrid', 'T5 the response names the timezone it bucketed in',
    d10.window.timezone);

  // …and it divides THAT Madrid day's spend.
  await manualSpend(FPIN, '2026-08-10', 50);
  await manualSpend(FPIN, '2026-08-09', 999); // the wrong day, on purpose
  const sd = await getSpendDaily({ start: '2026-08-09', end: '2026-08-10', funnelId: FPIN });
  const day9 = sd.series.find((x) => x.day === '2026-08-09');
  const day10 = sd.series.find((x) => x.day === '2026-08-10');
  ok(sd.spend_known === true, 'T5 manual spend makes the funnel spend KNOWN', JSON.stringify(sd.funnels));
  ok(day10.sales === 200 && day10.spend === 50 && day10.roas === 4,
    'T5 the 23:30Z order joins the 10th\'s spend → roas 200/50 = 4', JSON.stringify(day10));
  ok(day9.sales === 0 && day9.spend === 999 && day9.roas === 0,
    'T5 the 09th keeps its own spend and gets none of that revenue', JSON.stringify(day9));
}

// ═══ T6: DST — the 25-hour day and the 23-hour day ═════════════════════════
{
  // Madrid leaves DST on 2026-10-25 (03:00 CEST → 02:00 CET): a 25-hour day.
  await session('s_dst_a', { funnel: FAMB, vid: 'v_dst', paid: '2026-10-24T22:30:00Z', total: 10 }); // Oct25 00:30 CEST
  await session('s_dst_b', { funnel: FAMB, vid: 'v_dst', paid: '2026-10-25T22:30:00Z', total: 20 }); // Oct25 23:30 CET
  await session('s_dst_c', { funnel: FAMB, vid: 'v_dst', paid: '2026-10-25T23:30:00Z', total: 40 }); // Oct26 00:30 CET
  const fall = await getSpendDaily({ start: '2026-10-24', end: '2026-10-26', funnelId: FAMB });
  const o25 = fall.series.find((x) => x.day === '2026-10-25');
  const o26 = fall.series.find((x) => x.day === '2026-10-26');
  const o24 = fall.series.find((x) => x.day === '2026-10-24');
  ok(o25.sales === 30 && o25.orders === 2,
    'T6 the 25-HOUR day holds both 22:30Z instants (CEST and CET sides)', JSON.stringify(o25));
  ok(o26.sales === 40 && o24.sales === 0,
    'T6 …and 23:30Z on the 25th is already the 26th', JSON.stringify([o24, o26]));

  // Madrid enters DST on 2026-03-29 (02:00 CET → 03:00 CEST): a 23-hour day.
  await session('s_dst_d', { funnel: FAMB, vid: 'v_dst2', paid: '2026-03-28T23:30:00Z', total: 11 }); // Mar29 00:30 CET
  await session('s_dst_e', { funnel: FAMB, vid: 'v_dst2', paid: '2026-03-29T21:30:00Z', total: 22 }); // Mar29 23:30 CEST
  await session('s_dst_f', { funnel: FAMB, vid: 'v_dst2', paid: '2026-03-29T22:30:00Z', total: 44 }); // Mar30 00:30 CEST
  const spring = await getSpendDaily({ start: '2026-03-28', end: '2026-03-30', funnelId: FAMB });
  const m29 = spring.series.find((x) => x.day === '2026-03-29');
  const m30 = spring.series.find((x) => x.day === '2026-03-30');
  const m28 = spring.series.find((x) => x.day === '2026-03-28');
  ok(m29.sales === 33 && m29.orders === 2,
    'T6 the 23-HOUR day holds both of its instants', JSON.stringify(m29));
  ok(m30.sales === 44 && m28.sales === 0,
    'T6 …and the hour that does not exist locally shifts nothing else', JSON.stringify([m28, m30]));

  // The window itself is DST-safe: a 3-day window is 3 day keys, not 2.96.
  ok(spring.series.length === 3 && fall.series.length === 3,
    'T6 a 3-day window is 3 calendar day keys across BOTH transitions',
    `${spring.series.length}/${fall.series.length}`);
  ok(shiftDay('2026-03-29', -1) === '2026-03-28' && shiftDay('2026-10-25', 1) === '2026-10-26',
    'T6 day arithmetic is calendar arithmetic, immune to the transition');
  ok(dayKeyInTz(Date.parse('2026-08-09T23:30:00Z')) === '2026-08-10',
    'T6 dayKeyInTz agrees with Postgres on the same instant');
}

// ═══ T7: COST — all four branches, on real rows ════════════════════════════
const NOW = Date.parse('2026-08-09T12:00:00Z'); // Madrid day 2026-08-09
const CDAY = '2026-08-05';
const CTS = '2026-08-05T10:00:00Z';
{
  // (a) meta_api — platform spend, campaign-granular
  await session('s_api', { funnel: F1, vid: 'v_api', paid: `${CDAY}T11:00:00Z`, total: 300 });
  await click('c_api1', { vid: 'v_api', campaign: 'cmp_api', network: 'meta', ts: CTS, converted: true, sessionId: 's_api' });
  await click('c_api2', { vid: 'v_api2', campaign: 'cmp_api', network: 'meta', ts: CTS });
  await metaSpend('cmp_api', CDAY, 100);

  // (b) pin_manual — one campaign pinned to a funnel that carries manual spend
  await click('c_pin1', { funnel: FPIN, vid: 'v_pin', campaign: 'cmp_pin', network: 'taboola', ts: CTS });
  await pin('cmp_pin', 'fnl_pin_solo');
  await manualSpend('fnl_pin_solo', CDAY, 50);

  // (c) ledger — the &cost= macro
  await click('c_led1', { vid: 'v_led', campaign: 'cmp_ledger', network: 'mgid', cpc: 0.25, ts: CTS });
  await click('c_led2', { vid: 'v_led', campaign: 'cmp_ledger', network: 'mgid', cpc: 0.25, ts: CTS });
  await click('c_led3', { vid: 'v_led2', campaign: 'cmp_ledger', network: 'mgid', cpc: 0.5, ts: CTS });

  // (d) unknown — Meta templates no cost macro and no API row landed
  await click('c_unk', { vid: 'v_unk', campaign: 'cmp_none', network: 'meta', ts: CTS });

  // (e) pin_ambiguous — two campaigns pinned to one funnel, one manual number
  await click('c_amb', { funnel: FAMB, vid: 'v_amb', campaign: 'cmp_a1', network: 'taboola', ts: CTS });
  await pin('cmp_a1', 'fnl_amb_multi');
  await pin('cmp_a2', 'fnl_amb_multi');
  await manualSpend('fnl_amb_multi', CDAY, 80);

  const r = await getRoas({ days: 7, dimension: 'campaign' }, { now: NOW });
  const api = rowBy(r.rows, 'cmp_api');
  const pinRow = rowBy(r.rows, 'cmp_pin');
  const led = rowBy(r.rows, 'cmp_ledger');
  const unk = rowBy(r.rows, 'cmp_none');
  const amb = rowBy(r.rows, 'cmp_a1');

  ok(api && api.cost === 100 && api.cost_source === 'meta_api',
    'T7a meta_api — platform spend wins', JSON.stringify(api));
  ok(api.revenue === 300 && api.conversions === 1 && api.roas === 3 && api.cpa === 100,
    'T7a …and roas/cpa are computed off it', JSON.stringify(api));
  ok(pinRow && pinRow.cost === 50 && pinRow.cost_source === 'pin_manual',
    'T7b pin_manual — an unambiguous pin hands the funnel\'s manual spend over', JSON.stringify(pinRow));
  ok(led && led.cost === 1 && led.cost_source === 'ledger',
    'T7c ledger — Σ lb_clicks.cpc when no feed reached us', JSON.stringify(led));
  ok(unk && unk.cost === null && unk.cost_source === 'unknown' && unk.cost_unknown_reason === 'no_signal',
    'T7d unknown — NULL, never $0.00', JSON.stringify(unk));
  ok(unk.roas === null && unk.cpa === null,
    'T7d …and roas/cpa are withheld with it (never Infinity, never 0)', JSON.stringify(unk));
  ok(amb && amb.cost === null && amb.cost_unknown_reason === 'pin_ambiguous',
    'T7e two pinned campaigns and one manual number is REFUSED, not split', JSON.stringify(amb));
  ok(new Set(r.rows.map((x) => x.cost_source)).size >= 3 && r.cost_sources.length === 4,
    'T7 cost_source is a FIELD and the enum is published', JSON.stringify(r.cost_sources));

  // The granularity rule: campaign-granular spend is NOT folded at sub-id level.
  await click('c_sub', { vid: 'v_sub', campaign: 'cmp_api', network: 'meta', subs: { sub1: 'widget_a' }, ts: CTS });
  const rs = await getRoas({ days: 7, dimension: 'sub1' }, { now: NOW });
  const sub = rowBy(rs.rows, 'widget_a');
  ok(sub && sub.cost === null && sub.cost_unknown_reason === 'api_by_campaign_only',
    'T7f campaign-granular spend is never multiplied across sub-id groups', JSON.stringify(sub));
}

// ═══ T8: bots excluded from conversions, VISIBLE in the ledger ═════════════
{
  await session('s_botconv', { funnel: F1, vid: 'v_botconv', paid: `${CDAY}T11:00:00Z`, total: 500 });
  await click('c_botconv', {
    vid: 'v_botconv', campaign: 'cmp_botnet', network: 'meta', ts: CTS,
    converted: true, sessionId: 's_botconv', bot: true,
  });
  const r = await getRoas({ days: 7, dimension: 'campaign' }, { now: NOW });
  const row = rowBy(r.rows, 'cmp_botnet');
  ok(row && row.conversions === 0 && row.revenue === 0,
    'T8 a bot click marked converted contributes NO conversions and NO revenue', JSON.stringify(row));
  ok(row.clicks === 1 && row.bot_clicks === 1,
    'T8 …but it is counted and NAMED, not hidden', JSON.stringify(row));

  const ledger = await getClicks({ funnelId: F1, limit: 500 });
  const botRow = ledger.rows.find((x) => x.id === 'c_botconv');
  ok(botRow && botRow.bot === true && botRow.converted === true,
    'T8 the ledger SHOWS the excluded row (that is where an operator checks)', JSON.stringify(botRow));
  ok(botRow.day === dayKeyInTz(Date.parse(CTS)),
    'T8 ledger rows carry the Madrid day they are reported on', `${botRow.day}`);
  const cols = ['time', 'network', 'click_id', 'campaign', 'country', 'device', 'cpc', 'converted'];
  ok(cols.every((c) => c in botRow), 'T8 the ledger carries every specified column', JSON.stringify(Object.keys(botRow)));
  const netOnly = await getClicks({ funnelId: F1, network: 'mgid', limit: 10 });
  ok(netOnly.rows.length === 3 && netOnly.rows.every((x) => x.network === 'mgid'),
    'T8 the network filter is applied', String(netOnly.rows.length));
  const capped = await getClicks({ funnelId: F1, limit: 2 });
  ok(capped.rows.length === 2 && capped.truncated === true,
    'T8 the ledger admits when it truncated', JSON.stringify({ n: capped.rows.length, t: capped.truncated }));
}

// ═══ T9: cross-network dedup — per group full, window total once ═══════════
{
  await session('s_xnet', { funnel: F2, vid: 'v_xnet', paid: `${CDAY}T11:00:00Z`, total: 900 });
  await click('c_xnet_meta', {
    funnel: F2, vid: 'v_xnet', network: 'meta', campaign: 'cmp_x_meta', ts: CTS,
    converted: true, sessionId: 's_xnet',
  });
  await click('c_xnet_tt', {
    funnel: F2, vid: 'v_xnet', network: 'tiktok', campaign: 'cmp_x_tt', ts: CTS,
    converted: true, sessionId: 's_xnet',
  });
  const r = await getRoas({ funnelId: F2, days: 7, dimension: 'network' }, { now: NOW });
  const meta = rowBy(r.rows, 'meta');
  const tt = rowBy(r.rows, 'tiktok');
  ok(meta.conversions === 1 && meta.revenue === 900 && tt.conversions === 1 && tt.revenue === 900,
    'T9 each network group credits the whole journey once', JSON.stringify([meta, tt]));
  ok(r.totals.conversions === 1 && r.totals.revenue === 900,
    'T9 the WINDOW total counts that session ONCE — totals are not the sum of rows',
    JSON.stringify(r.totals));
}

// ═══ T10: zero-click, zero-spend, empty window — no div-by-zero ════════════
{
  const empty = await getRoas({ funnelId: 'fnl_does_not_exist', days: 30, dimension: 'network' }, { now: NOW });
  ok(empty.rows.length === 0 && empty.totals.clicks === 0, 'T10 a funnel with no clicks returns an empty report');
  ok(empty.totals.cost === null && empty.totals.roas === null && empty.totals.cpa === null,
    'T10 …with null cost/roas/cpa, not 0 and not Infinity', JSON.stringify(empty.totals));
  ok([empty.totals.roas, empty.totals.cpa, empty.totals.cost].every(finite),
    'T10 nothing in the totals is NaN or Infinity');

  const mk = await getMarketing({ start: '2020-01-01', end: '2020-01-02', dimension: 'source' });
  ok(mk.rows.length === 0 && mk.totals.orders === 0 && mk.totals.sales === 0 && mk.totals.rows_total === 0,
    'T10 an empty window returns empty rows and zero totals (a measured zero)', JSON.stringify(mk.totals));

  const sd = await getSpendDaily({ start: '2026-07-01', end: '2026-07-03', funnelId: F1 });
  ok(sd.spend_known === false && sd.series.every((x) => x.spend === null && x.roas === null),
    'T10 unmeasured spend is NULL on every day, never 0', JSON.stringify(sd.series));
  ok(sd.total === null, 'T10 …and the total is withheld too', String(sd.total));
  ok(sd.series.length === 3, 'T10 the series still has one entry per day', String(sd.series.length));

  // A row whose cost is a known 0 must not divide by it either.
  const z = resolveCost({ ledger_cost: 0, meta_ledger_cost: 0, campaigns: [], networks: ['meta'] },
    { campaignGrain: true });
  ok(z.cost === null && z.cost_source === 'unknown', 'T10 zero ledger cost is UNKNOWN, not free', JSON.stringify(z));
}

// ═══ T11: TTL flag ═════════════════════════════════════════════════════════
{
  const old = await getMarketing({ start: shiftDay(dayKeyInTz(Date.now()), -120), end: dayKeyInTz(Date.now()), dimension: 'campaign' });
  ok(old.attribution_ttl_risk === true && old.warnings.length === 1,
    'T11 a window past the 90-day click/touch TTL is FLAGGED, with a named warning',
    JSON.stringify(old.warnings));
  const recent = await getMarketing({ start: shiftDay(dayKeyInTz(Date.now()), -7), end: dayKeyInTz(Date.now()), dimension: 'campaign' });
  ok(recent.attribution_ttl_risk === false && recent.warnings.length === 0,
    'T11 …and a recent window is not');
}

// ═══ T12: malformed input is refused ═══════════════════════════════════════
{
  const cases = [
    [await getMarketing({ start: 'yesterday', end: '2026-06-10' }), 'invalid_date_format', 'malformed day'],
    [await getMarketing({ start: '2026-02-31', end: '2026-03-01' }), 'invalid_date', 'a day that does not exist'],
    [await getMarketing({ start: '2026-06-10', end: '2026-06-01' }), 'to_before_from', 'to before from'],
    [await getMarketing({ start: '2024-01-01', end: '2026-06-01' }), 'window_too_large', 'a 401+ day window'],
    [await getMarketing({ start: '2026-06-10', end: '2026-06-10', limit: 'lots' }), 'invalid_limit', 'a non-numeric limit'],
    [await getMarketing({ start: '2026-06-10', end: '2026-06-10', limit: 0 }), 'invalid_limit', 'limit 0'],
    [await getRoas({ days: 0 }), 'invalid_days', 'days 0'],
    [await getRoas({ days: -5 }), 'invalid_days', 'negative days'],
    [await getRoas({ dimension: 'sub11' }), 'invalid_dimension', 'a dimension outside the whitelist'],
    [await getClicks({ limit: 'all' }), 'invalid_limit', 'a non-numeric ledger limit'],
    [await getSpendDaily({ start: '2026-13-01', end: '2026-13-02' }), 'invalid_date', 'a month that does not exist'],
  ];
  for (const [res, expected, what] of cases) {
    ok(res.error === expected, `T12 ${what} → ${expected}`, JSON.stringify(res).slice(0, 120));
  }
  const clamped = await getRoas({ days: 9999, dimension: 'network' }, { now: NOW });
  ok(clamped.window.days === 180, 'T12 days is CLAMPED to the 180-day ceiling, not refused', String(clamped.window.days));
  const clampedLimit = await getClicks({ funnelId: F1, limit: 99999 });
  ok(clampedLimit.limit === 500, 'T12 the ledger limit is clamped to 500', String(clampedLimit.limit));
}

// ═══ T13: window defaults + resolveWindow are Madrid-anchored ══════════════
{
  const w = resolveWindow({}, { now: Date.parse('2026-08-09T23:30:00Z') });
  ok(w.to === '2026-08-10', 'T13 "today" with no params is the MADRID day, not the UTC day', w.to);
  ok(w.from === '2026-07-12' && w.days === 30, 'T13 the default window is 30 Madrid days', `${w.from}/${w.days}`);
  ok(w.tz === 'Europe/Madrid', 'T13 the window carries its timezone', w.tz);
}

// ═══ T14: the REAL router mounts, authenticates and serves ═════════════════
{
  const { default: express } = await import('express');
  const { default: attributionRoutes } = await import('../../src/routes/funnelAttribution.js');
  const { signAccessToken } = await import('../../src/utils/jwt.js');

  await sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
    must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE)`;
  await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
  await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
  await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_at','at@t.co','A','T')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO roles (id, name, permissions) VALUES
    ('r_at','funnels-tester', ${sql.json({ funnels: ['access'] })}) ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_at','r_at')`;
  const TOKEN = signAccessToken({ userId: 'u_at' });

  const app = express();
  app.use('/api/v1/funnel-attribution', attributionRoutes); // same mount as routes/index.js
  const server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 150));
  const base = `http://127.0.0.1:${PORT}/api/v1/funnel-attribution`;
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

  const anon = await fetch(`${base}/marketing?start=2026-06-10&end=2026-06-10`);
  ok(anon.status === 401, 'T14 no token → 401', String(anon.status));

  const mk = await fetch(`${base}/marketing?start=2026-06-10&end=2026-06-10&funnel_id=${F1}&dimension=campaign`, auth);
  const mkBody = await mk.json();
  ok(mk.status === 200 && mkBody.rows[0].key === 'winner' && mkBody.basis === BASIS,
    'T14 GET /marketing serves the same answer the engine computed', `${mk.status} ${JSON.stringify(mkBody.rows)}`);

  const bad = await fetch(`${base}/marketing?start=2026-06-10&end=2026-06-10&dimension=nope`, auth);
  ok(bad.status === 400 && (await bad.json()).error === 'invalid_dimension',
    'T14 an illegal dimension is a 400 from the route', String(bad.status));

  const roas = await fetch(`${base}/roas?days=7&dimension=campaign`, auth);
  ok(roas.status === 200 && Array.isArray((await roas.clone().json()).rows), 'T14 GET /roas serves', String(roas.status));
  const clicks = await fetch(`${base}/clicks?limit=5`, auth);
  ok(clicks.status === 200 && (await clicks.json()).rows.length === 5, 'T14 GET /clicks serves', String(clicks.status));
  const spend = await fetch(`${base}/spend-daily?start=2026-08-09&end=2026-08-10&funnel_id=${FPIN}`, auth);
  const spendBody = await spend.json();
  ok(spend.status === 200 && spendBody.window.timezone === 'Europe/Madrid',
    'T14 GET /spend-daily serves and names its timezone', JSON.stringify(spendBody.window));
  const defs = await fetch(`${base}/definitions`, auth);
  const defsBody = await defs.json();
  ok(defs.status === 200 && defsBody.timezone === 'Europe/Madrid' && defsBody.cost_sources.length === 4,
    'T14 GET /definitions publishes the vocabulary', String(defs.status));

  server.close();
}

// ── teardown ───────────────────────────────────────────────────────────────
await closeAnalyticsPool();
const { closePool } = await import('../../src/db/pg.js').then((m) => ({ closePool: m.closePool || m.default?.closePool }));
if (typeof closePool === 'function') await closePool();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
