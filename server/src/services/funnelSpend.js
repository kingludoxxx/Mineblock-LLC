// Per-funnel ad-spend feed — Meta campaign-level daily insights + the
// campaign→funnel binding + manual rows. Port of funnel-os
// backend/app/services/funnel_pnl_service.py (sync_meta_spend :804,
// derive_campaign_bindings :887-970, _spend_for :1268, catchup_days
// :117-152, maybe_periodic_sync :1436) onto Puure's lb_* tables.
//
// CREDIT MODEL (reference :873-885): the campaign→funnel binding is DERIVED
// from the attribution ledger for the window being asked about — paid
// co_sessions → their winning lb_clicks.struct.campaign_id (exclusive last
// click) → majority co_sessions.funnel_id. A campaign whose money landed on
// more than one funnel keeps the majority plus the full list, so a split is
// visible instead of silently rounded away. Derived bindings are computed,
// NEVER stored (a stored guess is a frozen vote new sales cannot correct);
// operator pins in lb_campaign_map win over derived, always.
//
// lb_clicks carries a 90-day TTL, so derived bindings only exist inside that
// horizon — stored pins are how attribution survives past it.
//
// SELF-HEALING WINDOW (reference :119-152): the periodic tick derives its
// re-pull range from OUR OWN last success, not a hardcoded 3 — a hardcoded
// window is what turned an 18-day feed outage into a permanent spend hole.
// Ceiling 90 days, matching Meta's insights limit — a catch-up must never
// ask for a range the API will reject.
//
// META PLUMBING: metaAdsApi.js owns ad LAUNCHING; per the lane fence its
// helpers are not imported — the account-listing shape is copied here (with
// this comment) and re-based on graphBase() so the harness can point the
// whole feed at a mock server (META_GRAPH_OVERRIDE_URL — same env-override
// seam the tracking harness uses via TRACKING_RELAY_OVERRIDE_URL).
// DELIBERATE DIFFERENCE from metaAdsApi.js: the token is sent as an
// Authorization: Bearer header, NEVER in the URL query string, and never
// logged — a token in a URL lands in access logs and error messages.
import { pgQuery } from '../db/pg.js';
import { ensureFunnelCostsTables } from './funnelCostsSchema.js';
// lb_clicks belongs to the tracking lane; its exported ensure is the
// supported way to guarantee the table exists before the binding join reads
// it (same import trackingAdmin.js uses — no DDL is duplicated here).
import { ensureTrackingTables } from './trackingSchema.js';

const META_API_TIMEOUT = 45000;

// Read at CALL time, not module load, so the harness can set the override
// after import and a token rotation needs no restart.
const graphBase = () => process.env.META_GRAPH_OVERRIDE_URL || 'https://graph.facebook.com/v21.0';
const metaToken = () => process.env.META_ACCESS_TOKEN || '';

export const metaConfigured = () => Boolean(metaToken());

// A source that has not landed a successful sync in this many hours is
// STALE — visible the same day, not two weeks later.
export const SPEND_STALE_AFTER_HOURS = 6;
// Healthy-path re-pull (Meta restates recent spend for several days) and the
// catch-up ceiling.
export const SPEND_PERIODIC_DAYS = 7;
export const SPEND_CATCHUP_MAX_DAYS = 90;
// Chunk size for the session_id ANY() join on lb_clicks.
const CLICK_CHUNK = 500;

const dayKeyUtc = (value = null) => {
  const d = value == null ? new Date() : new Date(value);
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
};
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same money predicate as funnelCosts.js / funnelAnalytics.js:198 —
// 'processing' is intent, not money.
const MONEY_MOVED_SQL = `s.paid_at IS NOT NULL AND s.status IN ('paid','refunded')`;

export class MetaApiError extends Error {
  constructor(status, body) {
    // body is the RESPONSE text — it can never contain our token (the token
    // travels only in the request header).
    super(`meta_api_${status}: ${String(body || '').slice(0, 300)}`);
    this.status = status;
  }
}

async function metaGet(path, params = {}) {
  const token = metaToken();
  if (!token) throw new MetaApiError(0, 'meta_not_configured');
  const usp = new URLSearchParams(params);
  const url = `${graphBase()}${path}${usp.toString() ? `?${usp}` : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(META_API_TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new MetaApiError(res.status, body);
  }
  return res.json();
}

// Follow Graph paging. Meta's paging.next echoes the ORIGINAL query string —
// which, because we authenticate by header, never contained the token — but
// it also points at the real Graph host, so re-anchor it onto graphBase()
// (keeps the mock seam airtight and never follows a redirect off-base).
async function metaGetPaged(path, params, maxPages) {
  const out = [];
  let page = await metaGet(path, params);
  for (let i = 0; i < maxPages; i++) {
    out.push(...(page.data || []));
    const next = page.paging && page.paging.next;
    if (!next) break;
    const u = new URL(next);
    page = await metaGet(u.pathname.replace(/^\/v\d+\.\d+/, ''), Object.fromEntries(u.searchParams));
  }
  return out;
}

// Every ad account the token can see. (Shape copied from
// metaAdsApi.discoverAdAccounts :189-214 — fence: helpers are copied, not
// imported — minus the launch-only fields, plus header auth.)
export async function listAdAccounts() {
  const rows = await metaGetPaged('/me/adaccounts', { fields: 'id,account_id,name', limit: '100' }, 5);
  return rows
    .map((a) => ({ id: String(a.id || ''), account_id: String(a.account_id || a.id || ''), name: a.name || '' }))
    .filter((a) => a.id);
}

const actId = (id) => (String(id).startsWith('act_') ? String(id) : `act_${id}`);

// Campaign-level daily spend for one account over [since, until] (inclusive
// day keys). level=campaign + time_increment=1 is the per-funnel unlock the
// existing account-day kpiSystem cache cannot provide.
export async function fetchCampaignSpendDaily(accountId, since, until) {
  return metaGetPaged(`/${actId(accountId)}/insights`, {
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
  }, 20);
}

// ── sync-state ledger ──────────────────────────────────────────────────────
export async function recordSyncAttempt(source, ok, { error = null, state = null } = {}) {
  await ensureFunnelCostsTables();
  const [row] = await pgQuery(
    `INSERT INTO lb_spend_sync_state (source, last_attempt, last_ok, error, fail_streak, last_sync, state, updated_at)
     VALUES ($1, NOW(), $2, $3, CASE WHEN $2 THEN 0 ELSE 1 END,
             CASE WHEN $2 THEN NOW() ELSE NULL END, COALESCE($4, '{}'::jsonb), NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_attempt = NOW(),
       last_ok = $2,
       error = $3,
       fail_streak = CASE WHEN $2 THEN 0 ELSE lb_spend_sync_state.fail_streak + 1 END,
       last_sync = CASE WHEN $2 THEN NOW() ELSE lb_spend_sync_state.last_sync END,
       state = COALESCE($4, lb_spend_sync_state.state),
       updated_at = NOW()
     RETURNING *`,
    [source, Boolean(ok), error ? String(error).slice(0, 500) : null, state]
  );
  return row;
}

export async function getSyncState(source = 'meta') {
  await ensureFunnelCostsTables();
  const [row] = await pgQuery(`SELECT * FROM lb_spend_sync_state WHERE source = $1`, [source]);
  return row || null;
}

// How many days the next periodic sync should re-pull. Healthy → periodic;
// a feed that has been down → wide enough to cover the gap (+1 so the day
// the outage began, whose partial spend was never restated, is included);
// never synced → the full ceiling.
export function catchupDays(lastSync, now = null, { periodic = SPEND_PERIODIC_DAYS, ceiling = SPEND_CATCHUP_MAX_DAYS } = {}) {
  if (!lastSync) return ceiling;
  const then = new Date(lastSync).getTime();
  if (Number.isNaN(then)) return ceiling;
  const ageH = Math.max(0, ((now ? new Date(now).getTime() : Date.now()) - then) / 3600000);
  const gapDays = Math.ceil(ageH / 24) + 1;
  return Math.max(periodic, Math.min(gapDays, ceiling));
}

// ── the sync ───────────────────────────────────────────────────────────────
// Pull daily campaign-level spend from every ad account the token can see.
// Every outcome — success or failure — is PERSISTED so /spend/status can
// tell the truth; a Meta failure is a recorded failure, never a crash.
export async function syncMetaCampaignSpend(days = SPEND_PERIODIC_DAYS) {
  await ensureFunnelCostsTables();
  const span = Math.max(1, Math.min(parseInt(days, 10) || SPEND_PERIODIC_DAYS, SPEND_CATCHUP_MAX_DAYS));
  const until = dayKeyUtc();
  const since = dayKeyUtc(Date.now() - span * 86400000);

  if (!metaConfigured()) {
    await recordSyncAttempt('meta', false, {
      error: 'meta_not_configured',
      state: { since, until, errors: ['meta_not_configured'] },
    });
    return { ok: false, error: 'meta_not_configured', since, until };
  }

  let accounts;
  try {
    accounts = await listAdAccounts();
  } catch (err) {
    // Clear the previous run's per-account errors so `errors` can never show
    // a stale success-time list next to a live failure.
    const msg = `list_ad_accounts: ${err && err.message ? err.message : err}`;
    await recordSyncAttempt('meta', false, { error: msg, state: { since, until, errors: [] } });
    return { ok: false, error: msg, since, until };
  }

  let rowsN = 0;
  const campaigns = new Set();
  const errors = [];
  for (const acct of accounts) {
    let rows;
    try {
      rows = await fetchCampaignSpendDaily(acct.account_id || acct.id, since, until);
    } catch (err) {
      errors.push(`${acct.account_id || acct.id}: ${err && err.message ? err.message : err}`);
      continue;
    }
    for (const r of rows) {
      const cid = String(r.campaign_id || '');
      const day = String(r.date_start || '');
      if (!cid || !DAY_RE.test(day)) continue;
      campaigns.add(cid);
      await pgQuery(
        `INSERT INTO lb_ad_spend_daily (source, ref_id, day, spend, campaign_name, account_id, synced_at)
         VALUES ('meta', $1, $2, $3, $4, $5, NOW())
         ON CONFLICT (source, ref_id, day) DO UPDATE SET
           spend = EXCLUDED.spend,
           campaign_name = EXCLUDED.campaign_name,
           account_id = EXCLUDED.account_id,
           synced_at = NOW()`,
        [cid, day, round2(Number(r.spend || 0)), String(r.campaign_name || '').slice(0, 160), String(acct.account_id || acct.id).slice(0, 64)]
      );
      rowsN += 1;
    }
  }

  // "The API answered" is not the same as "we got spend": every account
  // erroring and zero rows landing is a FAILURE, and it says so.
  const ok = rowsN > 0 || errors.length === 0;
  const err = ok ? null : errors.slice(0, 3).join('; ');
  const state = {
    since, until,
    accounts: accounts.length,
    campaigns: campaigns.size,
    rows: rowsN,
    errors: errors.slice(0, 5),
  };
  const recorded = await recordSyncAttempt('meta', ok, { error: err, state });
  const out = { ok, ...state, last_sync: recorded.last_sync, last_attempt: recorded.last_attempt };
  if (!ok) out.error = err;
  return out;
}

// ── campaign → funnel binding (DERIVED, never stored) ──────────────────────
// {campaign_id: {fid, fids, sessions, split}} from the attribution ledger
// over [start, end] (day keys, inclusive). fid = MAJORITY funnel; fids =
// every funnel this campaign's money landed on, most sessions first; ties
// break on the funnel id so the result is deterministic.
export async function deriveCampaignBindings(start, end) {
  await ensureTrackingTables();
  const loIso = `${start}T00:00:00Z`;
  const hiIso = `${dayKeyUtc(new Date(`${end}T00:00:00Z`).getTime() + 86400000)}T00:00:00Z`;
  const sessions = await pgQuery(
    `SELECT s.id, s.funnel_id, s.vid, s.paid_at
     FROM co_sessions s
     WHERE ${MONEY_MOVED_SQL} AND s.paid_at >= $1 AND s.paid_at < $2
       AND s.funnel_id IS NOT NULL AND s.funnel_id <> ''`,
    [loIso, hiIso]
  );
  if (!sessions.length) return {};
  const paidAtBySid = new Map(sessions.map((s) => [String(s.id), s.paid_at ? new Date(s.paid_at).getTime() : 0]));

  // Exclusive LAST click per session: first by the conversion-stamped
  // session_id, then (for sessions no click was stamped to) by vid — in that
  // order of trust. Bot rows never vote (m6): a click farm must not be able
  // to re-route a campaign's spend. Both draws ORDER BY ts, id so the tie on
  // an identical instant is deterministic (m8) — the takeClick >= keeps the
  // LAST row drawn, i.e. the highest (ts, id).
  const best = new Map(); // session.id → {ts, cid}
  const takeClick = (sid, c, { maxTs = null } = {}) => {
    const cid = String(((c.struct || {}).campaign_id) || '').trim();
    if (!cid) return;
    // PARSE the instant — never string-compare a timestamptz.
    const ts = c.ts ? new Date(c.ts).getTime() : 0;
    // m7 — a click AFTER the purchase cannot have caused it. Applied on the
    // vid fallback, where nothing else anchors the click to the session.
    if (maxTs !== null && ts > maxTs) return;
    const prev = best.get(sid);
    if (!prev || ts >= prev.ts) best.set(sid, { ts, cid });
  };

  const sids = sessions.map((s) => String(s.id));
  for (let i = 0; i < sids.length; i += CLICK_CHUNK) {
    const chunk = sids.slice(i, i + CLICK_CHUNK);
    const clicks = await pgQuery(
      `SELECT session_id, struct, ts FROM lb_clicks
       WHERE session_id = ANY($1) AND bot = FALSE
       ORDER BY ts, id`,
      [chunk]
    );
    for (const c of clicks) takeClick(String(c.session_id), c);
  }
  const unmatched = sessions.filter((s) => !best.has(String(s.id)) && s.vid);
  const vidToSids = new Map();
  for (const s of unmatched) {
    const v = String(s.vid);
    if (!vidToSids.has(v)) vidToSids.set(v, []);
    vidToSids.get(v).push(String(s.id));
  }
  const vids = [...vidToSids.keys()];
  for (let i = 0; i < vids.length; i += CLICK_CHUNK) {
    const chunk = vids.slice(i, i + CLICK_CHUNK);
    const clicks = await pgQuery(
      `SELECT vid, struct, ts FROM lb_clicks
       WHERE vid = ANY($1) AND bot = FALSE
       ORDER BY ts, id`,
      [chunk]
    );
    for (const c of clicks) {
      for (const sid of vidToSids.get(String(c.vid)) || []) {
        takeClick(sid, c, { maxTs: paidAtBySid.get(sid) || null });
      }
    }
  }

  const funnelBySid = new Map(sessions.map((s) => [String(s.id), String(s.funnel_id)]));
  const votes = new Map(); // cid → Map(fid → n)
  for (const [sid, { cid }] of best) {
    const fid = funnelBySid.get(sid);
    if (!fid) continue;
    if (!votes.has(cid)) votes.set(cid, new Map());
    const byFid = votes.get(cid);
    byFid.set(fid, (byFid.get(fid) || 0) + 1);
  }

  const out = {};
  for (const [cid, byFid] of votes) {
    const ranked = [...byFid.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out[cid] = {
      fid: ranked[0][0],
      fids: ranked.map(([f]) => f),
      sessions: ranked.reduce((s, [, n]) => s + n, 0),
      split: ranked.length > 1,
    };
  }
  return out;
}

// ── per-funnel spend (reference _spend_for :1268) ──────────────────────────
// {days: {fid: {day: spend}}, known: {fid: bool}} over [start, end].
// Derived bindings first, then EVERY stored pin on top (a pin is the
// strongest statement there is — it both claims a campaign for its funnel
// and takes it away from whatever the vote said), then manual rows.
// known[fid] is honest tri-state input for the P&L: true only when the meta
// feed has actually synced AND the funnel has ≥1 bound campaign, or the
// operator has typed manual spend. Everything else renders spend null /
// spend_known false — a zero would read as "no ad spend", the opposite of
// the truth.
export async function funnelSpendByDay(fids, start, end, { bindStart = null } = {}) {
  await ensureFunnelCostsTables();
  const wanted = [...new Set((fids || []).map((f) => String(f)).filter(Boolean))];
  const days = {};
  const known = {};
  for (const f of wanted) { days[f] = {}; known[f] = false; }
  if (!wanted.length) return { days, known };

  // bindStart widens the window used to DERIVE the binding without widening
  // the spend window — a funnel that is DOWN has no sales today, and binding
  // on the spend window alone would leave exactly the campaigns you most
  // need attributed unbound.
  const bindings = await deriveCampaignBindings(bindStart || start, end);
  const cmpToFid = new Map();
  for (const [cid, b] of Object.entries(bindings)) {
    const fid = String((b || {}).fid || '');
    if (wanted.includes(fid)) cmpToFid.set(cid, fid);
  }
  // Pins win — including a pin that moves a campaign to a funnel OUTSIDE the
  // asked-for set, which must REMOVE the derived credit here.
  const pins = await pgQuery(`SELECT campaign_id, funnel_id FROM lb_campaign_map`);
  for (const p of pins) {
    const cid = String(p.campaign_id);
    const fid = String(p.funnel_id);
    if (wanted.includes(fid)) cmpToFid.set(cid, fid);
    else cmpToFid.delete(cid);
  }

  const state = await getSyncState('meta');
  const feedSynced = Boolean(state && state.last_sync);

  if (cmpToFid.size) {
    const rows = await pgQuery(
      `SELECT ref_id, day, spend FROM lb_ad_spend_daily
       WHERE source = 'meta' AND ref_id = ANY($1) AND day >= $2 AND day <= $3`,
      [[...cmpToFid.keys()], start, end]
    );
    for (const r of rows) {
      const fid = cmpToFid.get(String(r.ref_id));
      if (!fid) continue;
      const day = String(r.day);
      days[fid][day] = round2(Number(days[fid][day] || 0) + Number(r.spend || 0));
    }
    if (feedSynced) {
      for (const fid of cmpToFid.values()) known[fid] = true;
    }
  }

  const manual = await pgQuery(
    `SELECT ref_id, day, spend FROM lb_ad_spend_daily
     WHERE source = 'manual' AND ref_id = ANY($1) AND day >= $2 AND day <= $3`,
    [wanted, start, end]
  );
  for (const r of manual) {
    const fid = String(r.ref_id);
    if (!(fid in days)) continue;
    const day = String(r.day);
    days[fid][day] = round2(Number(days[fid][day] || 0) + Number(r.spend || 0));
    known[fid] = true;
  }
  return { days, known };
}

// ── health ─────────────────────────────────────────────────────────────────
export async function spendStatus() {
  await ensureFunnelCostsTables();
  const state = await getSyncState('meta');
  const configured = metaConfigured();
  const now = Date.now();
  const lastSync = state && state.last_sync ? new Date(state.last_sync) : null;
  const ageHours = lastSync ? round2((now - lastSync.getTime()) / 3600000) : null;
  const stale = configured && (!lastSync || ageHours >= SPEND_STALE_AFTER_HOURS);
  const [pinCount] = await pgQuery(`SELECT COUNT(*)::int AS n FROM lb_campaign_map`);
  const errors = [];
  if (configured && state && state.last_ok === false && state.error) errors.push(state.error);
  if (configured && !state) errors.push('meta feed has never attempted a sync');
  if (stale && lastSync) errors.push(`meta feed stale: last success ${ageHours}h ago`);
  return {
    configured,
    meta_configured: configured,
    last_sync: lastSync ? lastSync.toISOString() : null,
    last_sync_age_hours: ageHours,
    last_attempt: state && state.last_attempt ? new Date(state.last_attempt).toISOString() : null,
    last_ok: state ? state.last_ok : null,
    error: (state && state.error) || null,
    fail_streak: state ? Number(state.fail_streak || 0) : 0,
    state: (state && state.state) || {},
    pinned_campaigns: pinCount ? Number(pinCount.n) : 0,
    stale,
    healthy: configured && !stale,
    stale_after_hours: SPEND_STALE_AFTER_HOURS,
    checked_at: new Date(now).toISOString(),
  };
}

// ── the in-process tick ────────────────────────────────────────────────────
// Started from the route ensure path (no render.yaml cron edit — the lane
// fence). Throttled on the ATTEMPT, not on success: a blocked token must not
// be retried on every request forever (reference :1454-1458). The window is
// derived from our own last success (catchupDays), so a gap of any length
// inside the 90-day ceiling closes on the first successful tick.
const TICK_MS = 30 * 60 * 1000;
let _lastTickAttempt = 0;
let _tickTimer = null;

export async function maybeSpendSync(now = Date.now()) {
  if (now - _lastTickAttempt < TICK_MS) return { skipped: 'throttled' };
  _lastTickAttempt = now; // advance on the ATTEMPT
  if (!metaConfigured()) return { skipped: 'not_configured' };
  let state = null;
  try {
    state = await getSyncState('meta');
  } catch {
    // A state read must never be the reason spend stops syncing — fall back
    // to the healthy-path window. (The sync itself still records failures.)
    state = null;
  }
  const days = catchupDays(state && state.last_sync);
  try {
    return await syncMetaCampaignSpend(days);
  } catch (err) {
    // The sync records API failures itself; this catches infra failures so a
    // background tick can never take a request down. Recorded, not swallowed.
    const msg = `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`;
    await recordSyncAttempt('meta', false, { error: msg });
    return { ok: false, error: msg };
  }
}

export function startSpendTicker() {
  if (_tickTimer) return _tickTimer;
  // Fire-and-forget on the request path — a spend sync must never block or
  // fail an API response. maybeSpendSync records its own failures.
  maybeSpendSync().catch((err) => {
    console.error('[funnelSpend] tick failed:', err && err.message ? err.message : err);
  });
  _tickTimer = setInterval(() => {
    maybeSpendSync().catch((err) => {
      console.error('[funnelSpend] tick failed:', err && err.message ? err.message : err);
    });
  }, TICK_MS);
  if (_tickTimer.unref) _tickTimer.unref();
  return _tickTimer;
}

// Harness-only: reset the throttle so a test can drive two ticks.
export function _resetTickThrottleForTests() {
  _lastTickAttempt = 0;
}

export default { syncMetaCampaignSpend, funnelSpendByDay, spendStatus, startSpendTicker };
