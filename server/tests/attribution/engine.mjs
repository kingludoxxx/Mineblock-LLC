// ATTRIBUTION ENGINE verification (LANE 2) — drives the REAL
// funnelAttribution.js (getMarketing / getRoas / getClicks / getSpendDaily)
// and the REAL router against embedded PG. Proves by execution:
//
//   1. THE STITCH — the last touch BEFORE payment wins; a click after paid_at
//      never re-attributes a closed order; a stamped click beats a later
//      unstamped one; a bot click never attributes.
//   2. FUNNEL SCOPE (review F2) — a scoped question gets a scoped journey:
//      an fA click behind an fB order reads as unattributed inside fB, resolves
//      when unscoped, and /marketing and /roas AGREE either way.
//   3. 'direct / none' and '(not set)' are different rows, and the attribution
//      STATE (not the key text) decides — a real campaign named after a
//      sentinel keeps its own money (review F3).
//   4. Every breakdown names its basis (captured_base) + basis_label, and its
//      revenue_basis (order_window vs click_cohort — review F6).
//   5. Totals fold EVERY bucket, not the returned page.
//   6. COST — meta_api / pin_manual / ledger / mixed / unknown, plus
//      pin_ambiguous and api_by_campaign_only refusals; a KNOWN-PARTIAL never
//      looks clean (review F4); bot cpc is counted and NAMED (review F11).
//   7. The ROAS totals row folds the window's platform spend including
//      zero-click ghost campaigns (review F5).
//   8. Bot clicks excluded from conversions, VISIBLE in the ledger.
//   9. Cross-network revenue dedup: per-group full, window total once.
//  10. TIMEZONE (REPORT_TZ=Europe/Madrid): a 23:30Z conversion lands on the
//      NEXT Madrid day and divides THAT day's spend; both DST transitions.
//  11. SCALE (review F1) — 50,000 clicks / 2,500 paid sessions resolve inside
//      the analytics pool's 8s budget, with EXPLAIN of the REAL query showing
//      the BitmapOr over idx_lb_clicks_session + idx_lb_clicks_vid.
//  12. Zero-click / zero-spend / empty window: no division by zero, no NaN,
//      no Infinity; unknown spend is null, never 0.
//  13. Malformed input refused; every windowed endpoint capped at 180 days
//      (review F8); /clicks accepts an optional window (review F9); the
//      funnel fan-out is ordered and admits truncation (review F7).
//  14. The REAL router mounts, 401s without a token and serves with one.
//
// Run:  node server/tests/attribution/engine.mjs
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_attribution_engine';
const PORT = 0; // OS-assigned at listen time (see T14)

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

const {
  getMarketing, getRoas, getClicks, getSpendDaily,
  resolveKeys, resolveCost, resolveWindow, readAttributedSessions,
  dayKeyInTz, shiftDay, REPORT_TZ, DIRECT_KEY, NOT_SET_KEY, BASIS, MARKETING_DIMENSIONS,
} = await import('../../src/services/funnelAttribution.js');
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

// The one index this lane added to trackingSchema (review F1 BLOCKER).
{
  const idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_lb_clicks_session'`;
  ok(idx.length === 1, 'setup idx_lb_clicks_session exists after the REAL trackingSchema ensure',
    JSON.stringify(idx));
}

// ── fixtures ───────────────────────────────────────────────────────────────
const F1 = 'fnl_attr_alpha';
const F2 = 'fnl_attr_beta';
const FPIN = 'fnl_attr_pin';
const FAMB = 'fnl_attr_amb';
const FA = 'fnl_attr_xf_a';   // cross-funnel: the ad ran here
const FB = 'fnl_attr_xf_b';   // cross-funnel: the order landed here
const FSCALE = 'fnl_attr_scale';
const FMIX = 'fnl_attr_mixed';
await sql`INSERT INTO funnels (id, slug, name) VALUES
  (${F1},'attr-alpha','Attr Alpha'), (${F2},'attr-beta','Attr Beta'),
  (${FPIN},'attr-pin','Attr Pin'), (${FAMB},'attr-amb','Attr Amb'),
  (${FA},'attr-xf-a','Attr XF A'), (${FB},'attr-xf-b','Attr XF B'),
  (${FSCALE},'attr-scale','Attr Scale'), (${FMIX},'attr-mixed','Attr Mixed')`;

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

// ═══ T0: PURE — resolveKeys branches and STATES, no database ═══════════════
{
  const none = resolveKeys({});
  ok(none.keys.campaign === DIRECT_KEY && none.keys.referrer === DIRECT_KEY,
    'T0 no click and no touch → every key is "direct / none"', JSON.stringify(none.keys));
  ok(none.attribution.campaign === 'none' && none.attribution.source === 'none',
    'T0 …and the STATE says none', JSON.stringify(none.attribution));
  const seen = resolveKeys({ has_touch: true, touch_utm: {}, touch_url: 'https://s.test/lp?x=1' });
  ok(seen.keys.campaign === NOT_SET_KEY && seen.attribution.campaign === 'untagged',
    'T0 visit seen but untagged → "(not set)" / state untagged', JSON.stringify(seen.attribution));
  ok(seen.keys.landing_page === 's.test/lp' && seen.attribution.landing_page === 'resolved',
    'T0 landing page keys on host+path, query dropped, state resolved', seen.keys.landing_page);
  ok(seen.keys.referrer === DIRECT_KEY && seen.attribution.referrer === 'none',
    'T0 blank referrer with a visit IS "direct / none" (nothing referred them)');
  const full = resolveKeys({
    has_click: true, network: 'meta',
    click_utm: { utm_campaign: 'summer', utm_source: 'fb' },
    click_struct: { campaign_id: '123' },
    landing_url: 'https://s.test/lp?fbclid=x',
    has_touch: true, referrer: 'https://news.test/article/9',
  });
  ok(full.keys.campaign === 'summer' && full.keys.source === 'fb'
    && full.keys.referrer === 'news.test' && full.keys.landing_page === 's.test/lp',
  'T0 utm wins, referrer reduces to host, query stripped', JSON.stringify(full.keys));
  ok(Object.values(full.attribution).every((s) => s === 'resolved'),
    'T0 …every dimension resolved', JSON.stringify(full.attribution));
  const structOnly = resolveKeys({ has_click: true, network: 'meta', click_struct: { campaign_id: '99' } });
  ok(structOnly.keys.campaign === '99' && structOnly.keys.source === 'meta',
    'T0 no utm → struct.campaign_id, then the network names the source');
  // F3: a REAL campaign named after a sentinel is state-resolved, not merged.
  const impostor = resolveKeys({ has_click: true, click_utm: { utm_campaign: DIRECT_KEY } });
  ok(impostor.keys.campaign === DIRECT_KEY && impostor.attribution.campaign === 'resolved',
    'T0 a campaign literally named "direct / none" is RESOLVED, not unattributed',
    JSON.stringify(impostor.attribution));
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

// ═══ T1b: FUNNEL SCOPE — review F2 ═════════════════════════════════════════
{
  // The ad ran on funnel A; the same visitor bought on funnel B. No stamp — the
  // vid branch is the live one, which is exactly what leaked before.
  await session('s_xf', { funnel: FB, vid: 'v_xf', paid: '2026-06-15T12:00:00Z', total: 250 });
  await click('c_xf', { funnel: FA, vid: 'v_xf', campaign: 'xf_camp', network: 'meta', ts: '2026-06-15T09:00:00Z' });
  await touch('v_xf', { funnel: FA, utm: { utm_campaign: 'xf_camp' }, ts: '2026-06-15T09:00:00Z' });

  const scoped = await getMarketing({ start: '2026-06-15', end: '2026-06-15', funnelId: FB, dimension: 'campaign' });
  ok(scoped.rows.length === 1 && scoped.rows[0].key === DIRECT_KEY
    && scoped.rows[0].attribution === 'none',
  'T1b scoped to fB, an fA click behind the order is NOT this funnel\'s acquisition',
  JSON.stringify(scoped.rows));
  ok(scoped.funnel_scoped === true, 'T1b …and the response says it was scoped');

  const unscoped = await getMarketing({ start: '2026-06-15', end: '2026-06-15', dimension: 'campaign' });
  ok(rowBy(unscoped.rows, 'xf_camp')?.sales === 250,
    'T1b unscoped, the resolver stays visitor-global and resolves the campaign',
    JSON.stringify(unscoped.rows.map((x) => x.key)));
  ok(unscoped.funnel_scoped === false, 'T1b …and says it was not scoped');

  // THE AGREEMENT: /roas scoped to fB also sees no click, so the two cards on
  // one page tell the same story.
  const roasB = await getRoas({ funnelId: FB, days: 90, dimension: 'campaign' },
    { now: Date.parse('2026-06-20T12:00:00Z') });
  ok(roasB.rows.length === 0,
    'T1b /roas scoped to fB has no click either — /marketing and /roas AGREE',
    JSON.stringify(roasB.rows));
  const roasA = await getRoas({ funnelId: FA, days: 90, dimension: 'campaign' },
    { now: Date.parse('2026-06-20T12:00:00Z') });
  ok(rowBy(roasA.rows, 'xf_camp')?.clicks === 1,
    'T1b …and fA owns the click it paid for', JSON.stringify(roasA.rows));
}

// ═══ T2: attribution STATE, not key text (review F3) ═══════════════════════
{
  await session('s_dark', { funnel: F2, vid: null, paid: '2026-06-13T12:00:00Z', total: 40 });
  await session('s_untagged', { funnel: F2, vid: 'v_untag', paid: '2026-06-13T13:00:00Z', total: 60 });
  await touch('v_untag', { funnel: F2, utm: {}, url: 'https://shop.test/offer', ts: '2026-06-13T12:30:00Z' });
  // The impostor: a REAL campaign whose name collides with the sentinel.
  await session('s_impostor', { funnel: F2, vid: 'v_imp', paid: '2026-06-13T14:00:00Z', total: 777 });
  await click('c_impostor', {
    funnel: F2, vid: 'v_imp', utm: { utm_campaign: DIRECT_KEY }, ts: '2026-06-13T13:30:00Z',
  });

  const r = await getMarketing({ start: '2026-06-13', end: '2026-06-13', funnelId: F2, dimension: 'campaign' });
  const unattributed = r.rows.filter((x) => x.is_unattributed);
  const real = r.rows.find((x) => x.key === DIRECT_KEY && !x.is_unattributed);
  ok(r.rows.filter((x) => x.key === DIRECT_KEY).length === 2,
    'T2 the impostor campaign and the real sentinel are TWO rows, not one',
    JSON.stringify(r.rows.map((x) => [x.key, x.attribution, x.sales])));
  ok(real && real.sales === 777 && real.attribution === 'resolved',
    'T2 the real campaign keeps its own $777 — it is not laundered into unattributed',
    JSON.stringify(real));
  ok(real.label === 'direct / none (campaign)',
    'T2 …and its LABEL disambiguates it on screen while the key round-trips', real?.label);
  ok(unattributed.length === 2 && unattributed.reduce((s, x) => s + x.sales, 0) === 100,
    'T2 nothing-measured ($40) and seen-but-untagged ($60) stay separate and unattributed',
    JSON.stringify(unattributed.map((x) => [x.key, x.attribution, x.sales])));
  const land = await getMarketing({ start: '2026-06-13', end: '2026-06-13', funnelId: F2, dimension: 'landing_page' });
  ok(rowBy(land.rows, 'shop.test/offer')?.sales === 60,
    'T2 landing_page keys off the touch url', JSON.stringify(land.rows.map((x) => x.key)));
}

// ═══ T3: basis + revenue_basis on every breakdown (review F6) ══════════════
{
  for (const dim of MARKETING_DIMENSIONS) {
    const r = await getMarketing({ start: '2026-06-10', end: '2026-06-13', dimension: dim });
    ok(r.basis === BASIS && typeof r.basis_label === 'string' && r.basis_label.length > 20,
      `T3 ${dim} breakdown names its basis + basis_label`, `${r.basis} / ${r.basis_label}`);
    ok(r.revenue_basis === 'order_window' && r.revenue_basis_label.includes('window'),
      `T3 ${dim} names its REVENUE basis (order_window)`, r.revenue_basis);
  }
  const roas = await getRoas({ days: 7, dimension: 'network' }, { now: Date.parse('2026-08-09T12:00:00Z') });
  ok(roas.revenue_basis === 'click_cohort' && roas.revenue_basis_label.includes('after the window'),
    'T3 /roas names the DIFFERENT basis it uses (click_cohort)', roas.revenue_basis);
  const sd = await getSpendDaily({ start: '2026-06-10', end: '2026-06-13', funnelId: F1 });
  ok(sd.revenue_basis === 'order_window', 'T3 /spend-daily names its revenue basis', sd.revenue_basis);
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
  ok(spring.series.length === 3 && fall.series.length === 3,
    'T6 a 3-day window is 3 calendar day keys across BOTH transitions',
    `${spring.series.length}/${fall.series.length}`);
  ok(shiftDay('2026-03-29', -1) === '2026-03-28' && shiftDay('2026-10-25', 1) === '2026-10-26',
    'T6 day arithmetic is calendar arithmetic, immune to the transition');
  ok(dayKeyInTz(Date.parse('2026-08-09T23:30:00Z')) === '2026-08-10',
    'T6 dayKeyInTz agrees with Postgres on the same instant');
}

// ═══ T7: COST — every branch, on real rows ═════════════════════════════════
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
  ok(r.cost_sources.length === 5 && r.cost_sources.includes('mixed'),
    'T7 the cost_source enum is published and includes mixed', JSON.stringify(r.cost_sources));

  // The granularity rule: campaign-granular spend is NOT folded at sub-id level.
  await click('c_sub', { vid: 'v_sub', campaign: 'cmp_api', network: 'meta', subs: { sub1: 'widget_a' }, ts: CTS });
  const rs = await getRoas({ days: 7, dimension: 'sub1' }, { now: NOW });
  const sub = rowBy(rs.rows, 'widget_a');
  ok(sub && sub.cost === null && sub.cost_unknown_reason === 'api_by_campaign_only',
    'T7f campaign-granular spend is never multiplied across sub-id groups', JSON.stringify(sub));
}

// ═══ T7g: KNOWN-PARTIAL never looks clean (review F4) ══════════════════════
{
  // One group ('mixnet'), two campaigns: one pin resolvable ($50), one pinned
  // to a funnel with two pins (ambiguous), plus $1 of ledger cpc.
  await click('c_mix1', { funnel: FMIX, vid: 'v_mix1', campaign: 'cmp_mix_ok', network: 'mixnet', cpc: 0.5, ts: CTS });
  await click('c_mix2', { funnel: FMIX, vid: 'v_mix2', campaign: 'cmp_mix_amb', network: 'mixnet', cpc: 0.5, ts: CTS });
  await pin('cmp_mix_ok', 'fnl_mix_solo');
  await manualSpend('fnl_mix_solo', CDAY, 50);
  await pin('cmp_mix_amb', 'fnl_mix_multi');
  await pin('cmp_mix_amb2', 'fnl_mix_multi');
  await manualSpend('fnl_mix_multi', CDAY, 400);

  const r = await getRoas({ funnelId: FMIX, days: 7, dimension: 'network' }, { now: NOW });
  const mix = rowBy(r.rows, 'mixnet');
  ok(mix && mix.cost === 51, 'T7g the resolvable $50 pin + $1 ledger is REPORTED, not dropped',
    JSON.stringify(mix));
  ok(mix.cost_source === 'mixed',
    'T7g …under "mixed", never under a clean source name that hides the gap', mix?.cost_source);
  ok(/partial — 1 pinned campaign ambiguous and excluded/.test(mix.cost_note || ''),
    'T7g …and cost_note names how much is missing and why', mix?.cost_note);
  ok(mix.cost_unknown_reason === null && mix.roas !== null,
    'T7g a known-partial still yields a roas (off an admittedly partial cost)', JSON.stringify(mix));
}

// ═══ T7h: bot cpc is cost, and it is NAMED (review F11) ════════════════════
{
  await click('c_botcost', { funnel: FMIX, vid: 'v_botcost', network: 'botnet2', cpc: 0.5, bot: true, ts: CTS });
  const r = await getRoas({ funnelId: FMIX, days: 7, dimension: 'network' }, { now: NOW });
  const bn = rowBy(r.rows, 'botnet2');
  ok(bn && bn.cost === 0.5 && bn.cost_source === 'ledger',
    'T7h bot clicks still COST — the network charged for them', JSON.stringify(bn));
  ok(/1 bot click/.test(bn.cost_note || '') && /\$0\.50/.test(bn.cost_note || ''),
    'T7h …and the row says so, with the amount and the count', bn?.cost_note);
  ok(bn.conversions === 0 && bn.bot_clicks === 1,
    'T7h …while contributing no conversions', JSON.stringify(bn));
}

// ═══ T7i: the GHOST campaign — totals ≠ sum of rows (review F5) ════════════
{
  await metaSpend('cmp_ghost', CDAY, 5000); // spent $5,000, got ZERO clicks
  const r = await getRoas({ days: 7, dimension: 'campaign' }, { now: NOW });
  ok(!rowBy(r.rows, 'cmp_ghost'), 'T7i a zero-click campaign has no row (it had no clicks)');
  ok(r.totals.cost >= 5100,
    'T7i …but the TOTALS row folds its $5,000 — the money did leave the bank account',
    String(r.totals.cost));
  ok(r.totals.untracked_campaigns >= 1 && r.untracked_campaigns >= 1,
    'T7i untracked_campaigns counts the campaigns no row can show',
    String(r.totals.untracked_campaigns));
  ok(/no clicks in this window/.test(r.totals.cost_note || ''),
    'T7i …and the totals row says so in plain words', r.totals.cost_note);
  const rowSum = r.rows.reduce((s, x) => s + (x.cost || 0), 0);
  ok(r.totals.cost > rowSum,
    'T7i the footer is NOT recomputable from the rows, by design', `${r.totals.cost} vs ${rowSum}`);
  ok(r.totals.cost_source === 'mixed', 'T7i …and it names itself mixed', r.totals.cost_source);
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

  // review F9 — the optional window
  const unwindowed = await getClicks({ funnelId: F1, limit: 500 });
  const windowed = await getClicks({ funnelId: F1, limit: 500, start: CDAY, end: CDAY });
  ok(windowed.window?.start === CDAY && windowed.window?.timezone === 'Europe/Madrid',
    'T9F the ledger accepts a Madrid window and reports it', JSON.stringify(windowed.window));
  ok(windowed.rows.length < unwindowed.rows.length && windowed.rows.every((x) => x.day === CDAY),
    'T9F …and every row inside it is on that Madrid day',
    `${windowed.rows.length}/${unwindowed.rows.length}`);
  ok(unwindowed.window === null, 'T9F …while an unwindowed call says so explicitly');
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
  const today = dayKeyInTz(Date.now());
  const old = await getMarketing({ start: shiftDay(today, -120), end: today, dimension: 'campaign' });
  ok(old.attribution_ttl_risk === true && old.warnings.length === 1,
    'T11 a window past the 90-day click/touch TTL is FLAGGED, with a named warning',
    JSON.stringify(old.warnings));
  const recent = await getMarketing({ start: shiftDay(today, -7), end: today, dimension: 'campaign' });
  ok(recent.attribution_ttl_risk === false && recent.warnings.length === 0,
    'T11 …and a recent window is not');
}

// ═══ T12: malformed input refused; one 180-day ceiling (review F8) ═════════
{
  const cases = [
    [await getMarketing({ start: 'yesterday', end: '2026-06-10' }), 'invalid_date_format', 'malformed day'],
    [await getMarketing({ start: '2026-02-31', end: '2026-03-01' }), 'invalid_date', 'a day that does not exist'],
    [await getMarketing({ start: '2026-06-10', end: '2026-06-01' }), 'to_before_from', 'to before from'],
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
  // ONE ceiling, everywhere (review F8): 180 days is fine, 181 is not.
  const at180 = { start: shiftDay('2026-06-01', -179), end: '2026-06-01' };
  const at181 = { start: shiftDay('2026-06-01', -180), end: '2026-06-01' };
  ok((await getMarketing(at180)).window.days === 180, 'T12 /marketing accepts exactly 180 days');
  ok((await getMarketing(at181)).error === 'window_too_large', 'T12 /marketing refuses 181');
  ok((await getSpendDaily({ ...at181, funnelId: F1 })).error === 'window_too_large',
    'T12 /spend-daily refuses 181 — the SAME ceiling, not parseWindow\'s 400');
  ok((await getClicks({ ...at181, funnelId: F1 })).error === 'window_too_large',
    'T12 /clicks refuses 181 too');
  const clamped = await getRoas({ days: 9999, dimension: 'network' }, { now: NOW });
  ok(clamped.window.days === 180, 'T12 /roas days is CLAMPED to the same 180, not refused', String(clamped.window.days));
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

// ═══ T15: SCALE — 50,000 clicks / 2,500 paid sessions (review F1) ══════════
{
  const SDAY = '2026-05-01';
  await sql.unsafe(
    `INSERT INTO co_sessions (id, funnel_id, vid, status, total, currency, paid_at, created_at)
     SELECT 'ss_'||g, $1, 'v_s_'||g, 'paid', 25, 'USD',
            TIMESTAMPTZ '2026-05-01 06:00:00+00' + (g || ' seconds')::interval,
            TIMESTAMPTZ '2026-05-01 06:00:00+00'
     FROM generate_series(1, 2500) g`, [FSCALE]
  );
  // 2,500 STAMPED clicks (the branch the new index serves) …
  await sql.unsafe(
    `INSERT INTO lb_clicks (id, funnel_id, vid, network, click_key, click_id, struct, subs, utm,
                            cpc, country, device, bot, landing_url, first_seen, last_seen, ts,
                            converted, session_id, expires_at)
     SELECT 'ks_'||g, $1, 'v_s_'||g, 'meta', 'fbclid', 'cs_'||g,
            jsonb_build_object('campaign_id', 'scale_'||(g % 10)), '{}'::jsonb, '{}'::jsonb,
            NULL, '', '', FALSE, '',
            TIMESTAMPTZ '2026-05-01 05:00:00+00', TIMESTAMPTZ '2026-05-01 05:00:00+00',
            TIMESTAMPTZ '2026-05-01 05:00:00+00', TRUE, 'ss_'||g,
            TIMESTAMPTZ '2026-08-01 05:00:00+00'
     FROM generate_series(1, 2500) g`, [FSCALE]
  );
  // … and 47,500 unconverted ones, which is what makes a seq scan expensive.
  await sql.unsafe(
    `INSERT INTO lb_clicks (id, funnel_id, vid, network, click_key, click_id, struct, subs, utm,
                            cpc, country, device, bot, landing_url, first_seen, last_seen, ts,
                            converted, session_id, expires_at)
     SELECT 'ku_'||g, $1, 'v_u_'||g, 'meta', 'fbclid', 'cu_'||g,
            jsonb_build_object('campaign_id', 'scale_'||(g % 10)), '{}'::jsonb, '{}'::jsonb,
            NULL, '', '', FALSE, '',
            TIMESTAMPTZ '2026-05-01 05:00:00+00', TIMESTAMPTZ '2026-05-01 05:00:00+00',
            TIMESTAMPTZ '2026-05-01 05:00:00+00', FALSE, '',
            TIMESTAMPTZ '2026-08-01 05:00:00+00'
     FROM generate_series(1, 47500) g`, [FSCALE]
  );
  await sql`ANALYZE lb_clicks`;
  await sql`ANALYZE co_sessions`;
  const [{ n: clickCount }] = await sql`SELECT COUNT(*)::int AS n FROM lb_clicks WHERE funnel_id = ${FSCALE}`;
  const [{ n: sessCount }] = await sql`SELECT COUNT(*)::int AS n FROM co_sessions WHERE funnel_id = ${FSCALE}`;
  ok(clickCount === 50000 && sessCount === 2500,
    'T15 fixture is at the reviewer\'s scale (50,000 clicks / 2,500 paid sessions)',
    `${clickCount}/${sessCount}`);

  // EXPLAIN the REAL query FIRST — captured by injecting the query fn, so this
  // is the exact SQL the service runs, not a hand-written lookalike. Doing it
  // before the timed call means a regression prints its plan even if the timed
  // call then blows the budget.
  let capturedSql = null;
  let capturedParams = null;
  await readAttributedSessions(
    { funnelId: FSCALE, w: { from: SDAY, to: SDAY, days: 1, tz: REPORT_TZ } },
    { query: async (s, p) => { capturedSql = s; capturedParams = p; return []; } }
  );
  const planRows = await sql.unsafe(`EXPLAIN ${capturedSql}`, capturedParams);
  const plan = planRows.map((x) => x['QUERY PLAN']).join('\n');
  console.log(plan.split('\n').map((l) => `      | ${l}`).join('\n'));
  ok(/BitmapOr/.test(plan), 'T15 EXPLAIN of the REAL query shows a BitmapOr over the two disjuncts', plan);
  ok(/idx_lb_clicks_session/.test(plan),
    'T15 …and it uses idx_lb_clicks_session (the index this lane added)', plan);
  ok(/idx_lb_clicks_vid/.test(plan), 'T15 …alongside idx_lb_clicks_vid for the vid half', plan);
  ok(!/Seq Scan on lb_clicks/.test(plan), 'T15 …and never a sequential scan of lb_clicks', plan);

  const t = Date.now();
  let r;
  try {
    r = await getMarketing({ start: SDAY, end: SDAY, funnelId: FSCALE, dimension: 'campaign', limit: 50 });
  } catch (err) {
    // A statement_timeout here IS the blocker regressing. Report it as a FAIL
    // with its plan rather than crashing the run.
    r = { error: String(err?.message || err), meta: { computed_ms: Date.now() - t } };
  }
  const wall = Date.now() - t;
  ok(!r.error, 'T15 the scaled read COMPLETES — it does not hit the pool\'s 8s statement_timeout',
    JSON.stringify(r.error));
  ok(!r.error && r.totals.orders === 2500 && r.totals.rows_total === 10,
    'T15 …and it is CORRECT at scale (2,500 orders across 10 campaigns)',
    JSON.stringify(r.totals || r.error));
  ok(!r.error && r.meta.computed_ms < 8000 && wall < 8000,
    `T15 …inside the 8s analytics budget (computed_ms=${r.meta?.computed_ms}, wall=${wall}ms)`,
    `${r.meta?.computed_ms}/${wall}`);
  console.log(`      → scaled /marketing: computed_ms=${r.meta?.computed_ms}, wall=${wall}ms`);
}

// ═══ T16: funnel fan-out is ordered and admits truncation (review F7) ══════
{
  await sql.unsafe(
    `INSERT INTO funnels (id, slug, name) SELECT 'fnl_bulk_'||lpad(g::text,4,'0'),
      'bulk-'||g, 'Bulk '||g FROM generate_series(1, 505) g`
  );
  const sd = await getSpendDaily({ start: '2026-08-09', end: '2026-08-09' });
  ok(sd.funnels_truncated === true,
    'T16 a fan-out beyond the 500-funnel cap ADMITS it rather than silently under-reporting',
    JSON.stringify({ n: sd.funnels.length, t: sd.funnels_truncated }));
  ok(sd.funnels.length === 500, 'T16 …and takes exactly the cap', String(sd.funnels.length));
  const again = await getSpendDaily({ start: '2026-08-09', end: '2026-08-09' });
  ok(JSON.stringify(again.funnels) === JSON.stringify(sd.funnels),
    'T16 the ORDER BY id makes two identical requests return the same 500 funnels');
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
  // Port 0 = let the OS pick. A fixed port makes the harness fail with
  // EADDRINUSE when a previous run died before its server.close() — a harness
  // that cannot be re-run is not a harness.
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/v1/funnel-attribution`;
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

  const anon = await fetch(`${base}/marketing?start=2026-06-10&end=2026-06-10`);
  ok(anon.status === 401, 'T14 no token → 401', String(anon.status));

  const mk = await fetch(`${base}/marketing?start=2026-06-10&end=2026-06-10&funnel_id=${F1}&dimension=campaign`, auth);
  const mkBody = await mk.json();
  ok(mk.status === 200 && mkBody.rows[0].key === 'winner' && mkBody.basis === BASIS
    && mkBody.revenue_basis === 'order_window',
  'T14 GET /marketing serves the same answer the engine computed', `${mk.status} ${JSON.stringify(mkBody.rows)}`);

  const bad = await fetch(`${base}/marketing?start=2026-06-10&end=2026-06-10&dimension=nope`, auth);
  ok(bad.status === 400 && (await bad.json()).error === 'invalid_dimension',
    'T14 an illegal dimension is a 400 from the route', String(bad.status));
  const wide = await fetch(`${base}/marketing?start=2020-01-01&end=2026-06-01`, auth);
  ok(wide.status === 400 && (await wide.json()).error === 'window_too_large',
    'T14 an over-wide window is a 400 from the route', String(wide.status));

  const roas = await fetch(`${base}/roas?days=7&dimension=campaign`, auth);
  const roasBody = await roas.json();
  ok(roas.status === 200 && roasBody.revenue_basis === 'click_cohort',
    'T14 GET /roas serves and names its cohort basis', String(roas.status));
  const clicks = await fetch(`${base}/clicks?limit=5&start=${CDAY}&end=${CDAY}`, auth);
  const clicksBody = await clicks.json();
  ok(clicks.status === 200 && clicksBody.rows.length === 5 && clicksBody.window.start === CDAY,
    'T14 GET /clicks serves, honours the window and reports it', String(clicks.status));
  const spend = await fetch(`${base}/spend-daily?start=2026-08-09&end=2026-08-10&funnel_id=${FPIN}`, auth);
  const spendBody = await spend.json();
  ok(spend.status === 200 && spendBody.window.timezone === 'Europe/Madrid',
    'T14 GET /spend-daily serves and names its timezone', JSON.stringify(spendBody.window));
  const defs = await fetch(`${base}/definitions`, auth);
  const defsBody = await defs.json();
  ok(defs.status === 200 && defsBody.timezone === 'Europe/Madrid' && defsBody.cost_sources.length === 5,
    'T14 GET /definitions publishes the vocabulary', String(defs.status));

  server.close();
}

// ── teardown ───────────────────────────────────────────────────────────────
await closeAnalyticsPool();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
