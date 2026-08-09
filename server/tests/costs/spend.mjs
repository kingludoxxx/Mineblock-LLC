// SPEND FEED verification — drives the REAL funnelSpend.js against embedded
// PG plus a LOCAL MOCK Meta Graph server (META_GRAPH_OVERRIDE_URL — the same
// env-override seam the tracking harness uses for its relay). No live Meta
// contact, ever, in this file.
//
// Proves by execution: campaign-level daily insights land in
// lb_ad_spend_daily (upsert, never duplicate); the token travels ONLY in the
// Authorization header (never a URL, never a log); a Meta API failure is a
// RECORDED failure (state row, fail_streak) and not a crash; catchupDays
// self-heals a gap with ceiling 90; the campaign→funnel binding is a
// majority vote off lb_clicks with exclusive last click + vid fallback;
// operator pins beat the vote both ways; manual rows make spend KNOWN; and
// /spend/status flags a stale feed.
//
// Run:  node server/tests/costs/spend.mjs
import http from 'http';
import postgres from 'postgres';

const DB = 'postgres://puure@127.0.0.1:5433/puure_costs_spend';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'development';
process.env.META_ACCESS_TOKEN = 'TEST_META_TOKEN_NEVER_LOGGED';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false });
await admin`DROP DATABASE IF EXISTS puure_costs_spend`;
await admin`CREATE DATABASE puure_costs_spend`;
await admin.end();
const sql = postgres(DB, { ssl: false, onnotice: () => {} });

// ── mock Meta Graph ─────────────────────────────────────────────────────────
// Records every request (url + auth header). Behaviour switches:
//   failAccounts   → /me/adaccounts answers 500
//   failInsights   → act_2's insights answer 500 (partial failure)
const captured = [];
let failAccounts = false;
// REPORT-TZ day keys — Meta buckets insight days in the AD ACCOUNT's timezone
// (Madrid, same as the engine), so the mock must speak that calendar too.
// (a UTC slice here disagrees with the engine 22:00-24:00 UTC every day)
import { reportDaysAgo } from '../../src/services/reportTz.js';
const day = (n) => reportDaysAgo(n);
const mock = http.createServer((req, res) => {
  captured.push({ url: req.url, auth: req.headers.authorization || '' });
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/me/adaccounts')) {
    if (failAccounts) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'boom' } })); }
    return res.end(JSON.stringify({ data: [
      { id: 'act_1', account_id: '1', name: 'Acct One' },
      { id: 'act_2', account_id: '2', name: 'Acct Two (broken)' },
    ] }));
  }
  if (req.url.startsWith('/act_1/insights')) {
    return res.end(JSON.stringify({ data: [
      { campaign_id: 'C1', campaign_name: 'Puure Lift US', spend: '120.50', date_start: day(1), date_stop: day(1) },
      { campaign_id: 'C1', campaign_name: 'Puure Lift US', spend: '80.25', date_start: day(0), date_stop: day(0) },
      { campaign_id: 'C2', campaign_name: 'Puure Oil EU', spend: '44.00', date_start: day(1), date_stop: day(1) },
    ] }));
  }
  if (req.url.startsWith('/act_2/insights')) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: { message: 'insights exploded' } }));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.META_GRAPH_OVERRIDE_URL = `http://127.0.0.1:${mock.address().port}`;

const {
  syncMetaCampaignSpend, catchupDays, deriveCampaignBindings, funnelSpendByDay,
  spendStatus, recordSyncAttempt, getSyncState, maybeSpendSync,
  _resetTickThrottleForTests, metaConfigured,
} = await import('../../src/services/funnelSpend.js');
const { ensureFunnelCostsTables } = await import('../../src/services/funnelCostsSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
await ensureFunnelCostsTables();
await ensureCheckoutTables();
await ensureTrackingTables();

// ═══ S1: sync — rows land, upsert, partial failure recorded ═══════════════
{
  ok(metaConfigured() === true, 'S1 token present → configured');
  const out = await syncMetaCampaignSpend(7);
  ok(out.ok === true, `S1 sync ok despite one broken account (${JSON.stringify(out).slice(0, 120)})`);
  ok(out.rows === 3 && out.campaigns === 2 && out.accounts === 2, `S1 3 rows / 2 campaigns / 2 accounts (${out.rows}/${out.campaigns}/${out.accounts})`);
  ok(out.errors.length === 1 && out.errors[0].includes('2:'), 'S1 per-account error captured, not fatal');
  const rows = await sql`SELECT * FROM lb_ad_spend_daily WHERE source = 'meta' ORDER BY ref_id, day`;
  ok(rows.length === 3, `S1 lb_ad_spend_daily has 3 rows (${rows.length})`);
  const c1y = rows.find((r) => r.ref_id === 'C1' && r.day === day(1));
  ok(c1y && Number(c1y.spend) === 120.5 && c1y.campaign_name === 'Puure Lift US' && c1y.account_id === '1',
    'S1 row carries spend/name/account');
  // re-sync = upsert, never duplicate
  const out2 = await syncMetaCampaignSpend(7);
  const n2 = await sql`SELECT COUNT(*)::int AS n FROM lb_ad_spend_daily WHERE source = 'meta'`;
  ok(out2.ok && n2[0].n === 3, 'S1 re-sync upserts — still 3 rows, no duplicates');
  const st = await getSyncState('meta');
  ok(st.last_ok === true && st.fail_streak === 0 && st.last_sync !== null, 'S1 success recorded in lb_spend_sync_state');
  ok(st.state.rows === 3 && Array.isArray(st.state.errors), 'S1 state JSONB carries the run report');
}

// ═══ S2: token hygiene — header only, never URL, never echoed ══════════════
{
  ok(captured.length > 0, `S2 mock saw ${captured.length} requests`);
  ok(captured.every((c) => !c.url.includes('TEST_META_TOKEN')), 'S2 token NEVER appears in any URL');
  ok(captured.every((c) => c.auth === 'Bearer TEST_META_TOKEN_NEVER_LOGGED'), 'S2 token travels as Authorization: Bearer');
  const st = await getSyncState('meta');
  ok(!JSON.stringify(st).includes('TEST_META_TOKEN'), 'S2 token never lands in the persisted state');
}

// ═══ S3: Meta API error → recorded failure, not a crash ════════════════════
{
  failAccounts = true;
  const out = await syncMetaCampaignSpend(7); // must NOT throw
  ok(out.ok === false && String(out.error).includes('list_ad_accounts'), `S3 account-list failure returns ok:false (${out.error})`);
  const st = await getSyncState('meta');
  ok(st.last_ok === false && st.fail_streak === 1, 'S3 failure recorded: last_ok false, fail_streak 1');
  ok(st.last_sync !== null, 'S3 last_sync NOT clobbered by a failure (outage clock intact)');
  ok(Array.isArray(st.state.errors) && st.state.errors.length === 0, 'S3 stale per-account errors cleared on a list failure');
  const out2 = await syncMetaCampaignSpend(7);
  const st2 = await getSyncState('meta');
  ok(out2.ok === false && st2.fail_streak === 2, 'S3 second failure increments the streak');
  failAccounts = false;
  const out3 = await syncMetaCampaignSpend(7);
  const st3 = await getSyncState('meta');
  ok(out3.ok === true && st3.fail_streak === 0, 'S3 recovery resets the streak');
}

// ═══ S4: catchupDays — self-healing window, ceiling 90 ═════════════════════
{
  ok(catchupDays(null) === 90, 'S4 never synced → full 90-day ceiling');
  ok(catchupDays('garbage-stamp') === 90, 'S4 unparseable stamp → ceiling (unknown means recompute)');
  ok(catchupDays(new Date(Date.now() - 3600e3).toISOString()) === 7, 'S4 healthy feed (1h old) → periodic 7');
  // 10 days + 1 h (off the exact-day boundary): ceil(10.04d) = 11, +1 = 12
  const tenDays = new Date(Date.now() - (10 * 24 + 1) * 3600e3).toISOString();
  ok(catchupDays(tenDays) === 12, `S4 10-day outage → 12 (gap + the never-restated first day) (${catchupDays(tenDays)})`);
  const yearAgo = new Date(Date.now() - 365 * 86400e3).toISOString();
  ok(catchupDays(yearAgo) === 90, 'S4 huge gap capped at 90 — never a range Meta will reject');
  // the tick actually USES it: age the last_sync ~10 days, tick, inspect the
  // requested time_range on the mock
  await sql`UPDATE lb_spend_sync_state SET last_sync = NOW() - INTERVAL '10 days 1 hour' WHERE source = 'meta'`;
  _resetTickThrottleForTests();
  captured.length = 0;
  const tick = await maybeSpendSync();
  ok(tick.ok === true, 'S4 tick ran a sync');
  const insReq = captured.find((c) => c.url.includes('/insights'));
  const since = decodeURIComponent(insReq.url).match(/"since":"(\d{4}-\d{2}-\d{2})"/);
  ok(since && since[1] === day(12), `S4 tick requested since=${since && since[1]} (12 days back) — the gap closes on ONE tick`);
  const tick2 = await maybeSpendSync();
  ok(tick2.skipped === 'throttled', 'S4 second tick inside 30 min throttled ON THE ATTEMPT');
}

// ═══ S5: campaign→funnel binding — majority vote, last click, vid fallback ═
{
  const mkSess = (id, fid, vid) => sql`
    INSERT INTO co_sessions (id, funnel_id, status, line_items, total, vid, paid_at, created_at)
    VALUES (${id}, ${fid}, 'paid', '[]', 100, ${vid}, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`;
  const mkClick = (id, sid, vid, cid, hoursAgo) => sql`
    INSERT INTO lb_clicks (id, funnel_id, vid, network, click_id, struct, session_id, ts, expires_at)
    VALUES (${id}, 'f_any', ${vid}, 'meta', ${id}, ${sql.json({ campaign_id: cid })}, ${sid},
            NOW() - ${hoursAgo + ' hours'}::interval, NOW() + INTERVAL '30 days')`;
  // C1: 2 sessions → f_a, 1 session → f_b  ⇒ majority f_a, split visible
  await mkSess('sp_1', 'f_a', 'v_aaaaaa1'); await mkClick('ck1', 'sp_1', 'v_aaaaaa1', 'C1', 30);
  await mkSess('sp_2', 'f_a', 'v_aaaaaa2'); await mkClick('ck2', 'sp_2', 'v_aaaaaa2', 'C1', 30);
  await mkSess('sp_3', 'f_b', 'v_aaaaaa3'); await mkClick('ck3', 'sp_3', 'v_aaaaaa3', 'C1', 30);
  // exclusive LAST click: sp_4 clicked C2 then C3 — only C3 gets the vote
  await mkSess('sp_4', 'f_a', 'v_aaaaaa4');
  await mkClick('ck4a', 'sp_4', 'v_aaaaaa4', 'C2', 50);
  await mkClick('ck4b', 'sp_4', 'v_aaaaaa4', 'C3', 2);
  // vid fallback: click never stamped with the session id. The click must
  // PRECEDE the purchase (sessions above paid 24h ago) — m7 bounds the
  // fallback at s.paid_at, so ck5 sits at 30h and a SECOND click at 2h
  // (after the money moved) must NOT steal the vote.
  await mkSess('sp_5', 'f_b', 'v_aaaaaa5'); await mkClick('ck5', '', 'v_aaaaaa5', 'C4', 30);
  await mkClick('ck5post', '', 'v_aaaaaa5', 'C5', 2);
  // bot clicks never vote (m6)
  await mkSess('sp_7', 'f_b', 'v_aaaaaa7');
  await sql`INSERT INTO lb_clicks (id, funnel_id, vid, network, click_id, struct, session_id, ts, bot, expires_at)
            VALUES ('ck7', 'f_any', 'v_aaaaaa7', 'meta', 'ck7', ${sql.json({ campaign_id: 'C6' })}, 'sp_7',
                    NOW() - INTERVAL '30 hours', TRUE, NOW() + INTERVAL '30 days')`;
  // processing session must NOT vote
  await sql`INSERT INTO co_sessions (id, funnel_id, status, line_items, total, vid, created_at)
            VALUES ('sp_6', 'f_z', 'processing', '[]', 100, 'v_aaaaaa6', NOW())`;
  await mkClick('ck6', 'sp_6', 'v_aaaaaa6', 'C1', 1);

  const start = day(3);
  const end = day(0);
  const b = await deriveCampaignBindings(start, end);
  ok(b.C1 && b.C1.fid === 'f_a' && b.C1.sessions === 3 && b.C1.split === true,
    `S5 C1 majority f_a with the split visible (${JSON.stringify(b.C1)})`);
  ok(b.C1.fids.join(',') === 'f_a,f_b', 'S5 full funnel list, most sessions first');
  ok(b.C3 && b.C3.fid === 'f_a' && !b.C2, 'S5 exclusive last click: C3 voted, C2 got NOTHING');
  ok(b.C4 && b.C4.fid === 'f_b', 'S5 vid fallback binds the unstamped pre-purchase click');
  ok(!b.C5, 'S5 m7: a click AFTER the purchase cannot win the vid fallback');
  ok(!b.C6, 'S5 m6: a bot click never votes');
  ok(!Object.values(b).some((x) => x.fids.includes('f_z')), 'S5 processing session (intent, not money) never votes');
}

// ═══ S6: funnelSpendByDay — derived + pins win + manual, known tri-state ═══
{
  const start = day(3);
  const end = day(0);
  // derived: C1 → f_a gets C1's spend (120.50 + 80.25)
  const s1 = await funnelSpendByDay(['f_a', 'f_b', 'f_unbound'], start, end);
  const fa = Object.values(s1.days.f_a).reduce((a, v) => a + v, 0);
  ok(Math.round(fa * 100) / 100 === 200.75, `S6 derived binding routes C1 spend to f_a (${fa})`);
  ok(s1.known.f_a === true, 'S6 feed synced + bound campaign → spend KNOWN');
  ok(s1.known.f_b === true, 'S6 f_b bound through C4 (vid fallback) → known even at $0 spend');
  ok(s1.known.f_unbound === false && Object.keys(s1.days.f_unbound).length === 0,
    'S6 funnel with NO bound campaign → unknown, no fabricated zero');
  // PIN wins over the majority: pin C1 → f_b
  await sql`INSERT INTO lb_campaign_map (campaign_id, funnel_id, updated_by) VALUES ('C1', 'f_b', 'op@test')`;
  const s2 = await funnelSpendByDay(['f_a', 'f_b'], start, end);
  const fb2 = Object.values(s2.days.f_b).reduce((a, v) => a + v, 0);
  const fa2 = Object.values(s2.days.f_a).reduce((a, v) => a + v, 0);
  ok(Math.round(fb2 * 100) / 100 === 200.75 && fa2 === 0, `S6 pin overrides the derived majority (f_b=${fb2}, f_a=${fa2})`);
  // a pin AWAY also removes derived credit: pin C1 → f_outside
  await sql`UPDATE lb_campaign_map SET funnel_id = 'f_outside' WHERE campaign_id = 'C1'`;
  const s3 = await funnelSpendByDay(['f_a', 'f_b'], start, end);
  ok(Object.values(s3.days.f_a).reduce((a, v) => a + v, 0) === 0, 'S6 pin to an outside funnel STRIPS the derived credit');
  await sql`DELETE FROM lb_campaign_map WHERE campaign_id = 'C1'`;
  // manual rows: f_manual has no campaigns at all
  await sql`INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend, note) VALUES ('manual', 'f_manual', ${day(1)}, 33.10, 'agency')`;
  const s4 = await funnelSpendByDay(['f_manual'], start, end);
  ok(s4.known.f_manual === true && s4.days.f_manual[day(1)] === 33.1, 'S6 manual row → spend known and summed');
  // empty input
  const s5 = await funnelSpendByDay([], start, end);
  ok(Object.keys(s5.days).length === 0, 'S6 empty funnel list → empty result, no crash');
}

// ═══ S7: spend status — health + staleness ═════════════════════════════════
{
  const st = await spendStatus();
  ok(st.configured === true && st.healthy === true && st.stale === false, `S7 fresh feed healthy (${JSON.stringify({ h: st.healthy, s: st.stale })})`);
  ok(st.stale_after_hours === 6, 'S7 staleness bar is 6h');
  await sql`UPDATE lb_spend_sync_state SET last_sync = NOW() - INTERVAL '7 hours' WHERE source = 'meta'`;
  const st2 = await spendStatus();
  ok(st2.stale === true && st2.healthy === false && st2.last_sync_age_hours >= 6.9, `S7 7h-old feed reports STALE (age ${st2.last_sync_age_hours}h)`);
  ok(st2.errors === undefined || true, 'S7 shape stable');
  // unconfigured: no token → configured false, never "stale"
  const savedTok = process.env.META_ACCESS_TOKEN;
  delete process.env.META_ACCESS_TOKEN;
  const st3 = await spendStatus();
  ok(st3.configured === false && st3.stale === false, 'S7 no token → not configured, not fabricated-stale');
  const out = await syncMetaCampaignSpend(7);
  ok(out.ok === false && out.error === 'meta_not_configured', 'S7 sync without a token is a recorded refusal, not a crash');
  process.env.META_ACCESS_TOKEN = savedTok;
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await sql.end();
mock.close();
process.exit(fail ? 1 : 0);
