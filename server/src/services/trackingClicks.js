// Click-id vault + conversion stamping — faithful port of funnel-os
// backend/app/services/lb_clicks_service.py.
//
// ONE registry (CLICK_ID_NETWORK) is the single source of truth for which
// URL param names name which ad network. The touch parser derives its list
// FROM this registry rather than hardcoding three params — a hardcoded list
// is what previously left every non-Meta/Google/TikTok journey reading
// "direct" (TRACKING.md §5).
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';

const CLICK_TTL_MS = 90 * 24 * 3600 * 1000;

// ~17 built-in click-id params → network. Order matters: first match wins.
export const CLICK_ID_NETWORK = [
  ['fbclid', 'meta'],
  ['gclid', 'google'], ['wbraid', 'google'], ['gbraid', 'google'],
  ['ttclid', 'tiktok'],
  ['tblci', 'taboola'],
  ['obclid', 'outbrain'], ['ob_click_id', 'outbrain'], ['dicbo', 'outbrain'],
  ['sccid', 'snapchat'],
  ['epik', 'pinterest'],
  ['rdt_cid', 'reddit'],
  ['msclkid', 'microsoft'],
  ['li_fat_id', 'linkedin'],
  ['twclid', 'x'],
  ['mgid_click', 'mgid'],
  ['rc_uuid', 'revcontent'],
  ['nb_click_id', 'newsbreak'],
];

const STRUCT_KEYS = {
  campaign_id: ['campaign_id', 'campaignid', 'utm_campaign_id'],
  adset_id: ['adset_id', 'adsetid', 'adgroup_id', 'adgroupid'],
  ad_id: ['ad_id', 'adid'],
  creative_id: ['creative_id', 'creativeid', 'creative'],
  placement: ['placement', 'site', 'site_id', 'widget', 'widget_id', 'section_id'],
};
const SUB_KEYS = [...Array(10)].map((_, i) => `sub${i + 1}`).concat(['subid']);
const COST_KEYS = ['cost', 'cpc', 'bid', 'amount_paid', 'click_cost'];
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

const VID_RE = /^v_[a-z0-9]{6,40}$/;
export const isValidVid = (v) => VID_RE.test(String(v || ''));

// Lower-cased query map from a URL. Never throws.
function queryMap(url) {
  try {
    const u = new URL(String(url || ''), 'http://x');
    const q = {};
    for (const [k, v] of u.searchParams.entries()) {
      const lk = k.toLowerCase();
      if (!(lk in q)) q[lk] = String(v).slice(0, 200); // first value wins
    }
    return q;
  } catch {
    return {};
  }
}

function firstOf(q, keys) {
  for (const k of keys) {
    const v = q[k];
    if (v) return String(v).slice(0, 200);
  }
  return '';
}

// Cheap DB-free check: does the URL carry a KNOWN platform click id?
export function hasBuiltinClick(url) {
  const q = queryMap(url);
  return CLICK_ID_NETWORK.some(([param]) => q[param]);
}

// Extract a click record from a landing URL, or null if no click id present.
// customParams = the funnel's custom-network click-id params (optional).
export function parseClick(url, customParams = []) {
  const q = queryMap(url);
  let network = '';
  let clickKey = '';
  let clickVal = '';
  for (const [param, net] of CLICK_ID_NETWORK) {
    const v = firstOf(q, [param]);
    if (v) { network = net; clickKey = param; clickVal = v; break; }
  }
  if (!clickVal) {
    for (const param of customParams || []) {
      const lp = String(param).toLowerCase();
      const v = firstOf(q, [lp]);
      if (v) { network = `custom:${lp}`; clickKey = lp; clickVal = v; break; }
    }
  }
  if (!clickVal) return null;

  const subs = {};
  for (const k of SUB_KEYS) { const v = firstOf(q, [k]); if (v) subs[k] = v; }
  const struct = {};
  for (const [name, aliases] of Object.entries(STRUCT_KEYS)) {
    const v = firstOf(q, aliases); if (v) struct[name] = v;
  }
  const utm = {};
  for (const k of UTM_KEYS) { const v = firstOf(q, [k]); if (v) utm[k] = v; }

  let cpc = null;
  const costRaw = firstOf(q, COST_KEYS);
  if (costRaw) {
    const c = Number(costRaw);
    // Reject nan/inf/negative — a non-finite cpc corrupts spend/ROAS totals.
    if (Number.isFinite(c) && c >= 0 && c < 1e7) cpc = Math.round(c * 1e4) / 1e4;
  }
  return { network, click_key: clickKey, click_id: clickVal, subs, struct, utm, cpc };
}

// Parse the fbclid out of an `_fbc` cookie (`fb.1.<ts>.<fbclid>`). Used as a
// last-click fallback when a session captured no explicit click vault.
export function fbclidFromFbc(fbc) {
  const s = String(fbc || '');
  const m = s.match(/^fb\.\d+\.\d+\.(.+)$/);
  return m ? m[1].slice(0, 200) : '';
}

// Upsert one click row from a landing URL. Never raises; a URL with no click
// id is a silent no-op (organic/direct traffic isn't a click).
//
// bot / velocity_flag are set ONLY on insert (ON CONFLICT does NOT touch
// them) — a public touch beacon can never poison a victim's clean click.
export async function recordClick(funnelId, vid, url, {
  country = '', device = '', customParams = [], ipHash = '',
  bot = false, velocityFlag = false,
} = {}) {
  if (!isValidVid(vid)) return { ok: false, reason: 'bad_vid' };
  const parsed = parseClick(url, customParams);
  if (!parsed) return { ok: false, no_click: true };
  try {
    await ensureTrackingTables();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLICK_TTL_MS);
    // (funnel_id, vid, click_id) identifies the click. A refresh replay
    // refreshes cost/subs/last_seen but keeps first_seen, id and the fraud
    // flags stable (ON CONFLICT updates only the $set fields).
    const rows = await pgQuery(
      `INSERT INTO lb_clicks
         (id, funnel_id, vid, network, click_key, click_id, struct, subs, utm,
          cpc, country, device, ip_hash, bot, velocity_flag, landing_url,
          first_seen, last_seen, ts, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               NOW(), NOW(), NOW(), $17)
       ON CONFLICT (funnel_id, vid, click_id) DO UPDATE SET
         network = EXCLUDED.network,
         click_key = EXCLUDED.click_key,
         struct = EXCLUDED.struct,
         subs = EXCLUDED.subs,
         utm = EXCLUDED.utm,
         cpc = COALESCE(EXCLUDED.cpc, lb_clicks.cpc),
         country = COALESCE(NULLIF(EXCLUDED.country, ''), lb_clicks.country),
         device = COALESCE(NULLIF(EXCLUDED.device, ''), lb_clicks.device),
         landing_url = EXCLUDED.landing_url,
         last_seen = NOW(),
         ts = NOW(),
         expires_at = EXCLUDED.expires_at
       RETURNING (xmax = 0) AS inserted, network`,
      [
        `lbclk_${crypto.randomBytes(9).toString('hex')}`,
        String(funnelId || ''), vid, parsed.network, parsed.click_key, parsed.click_id,
        parsed.struct, parsed.subs, parsed.utm,
        parsed.cpc, country ? country.slice(0, 2).toUpperCase() : '',
        device ? String(device).slice(0, 16) : '',
        ipHash ? String(ipHash).slice(0, 32) : '',
        Boolean(bot), Boolean(velocityFlag), String(url || '').slice(0, 480),
        expiresAt,
      ]
    );
    return { ok: true, network: parsed.network, inserted: Boolean(rows[0]?.inserted) };
  } catch (err) {
    console.error('[tracking] click write failed (fail-open):', err.message);
    return { ok: false };
  }
}

// Mark the click(s) that led to a paid session — converted + session_id.
//
// Faithful to DECISIONS #10: prefer an EXACT click_id match from the
// session's captured vault; only if none matches does it attribute the
// visitor's single most-recent click. NEVER mass-marks by vid alone (that
// would double-count one order across every prior click of the visitor).
//
// Deviation from the reference (DECISION MADE): the reference requires a
// non-empty `vids`; ours accepts an empty vids WHEN explicit clickIds are
// supplied, matching by exact click_id scoped to the funnel. Puure's
// create-session does not yet persist the vid cookie, but the `_fbc` cookie
// still yields a last-click id — this keeps revenue last-click attribution
// working without a checkout-lane edit. Still never mass-marks: an exact
// click_id names exactly one ad click.
export async function stampConversion(sessionId, vids, clickIds = {}, { funnelId = '' } = {}) {
  const sid = String(sessionId || '').slice(0, 64);
  const vidList = (Array.isArray(vids) ? vids : []).filter(isValidVid);
  const vals = Object.values(clickIds || {}).map((v) => String(v || '').slice(0, 200)).filter(Boolean);
  if (!sid) return { stamped: 0, mode: 'no_session' };
  if (!vidList.length && !vals.length) return { stamped: 0, mode: 'no_identity' };
  try {
    await ensureTrackingTables();
    const scope = [];
    const params = [];
    params.push(sid);                       // $1 = session_id set value
    if (funnelId) { params.push(String(funnelId)); scope.push(`funnel_id = $${params.length}`); }
    const vidClause = vidList.length
      ? (params.push(vidList), `vid = ANY($${params.length})`)
      : '';
    const scopeSql = scope.length ? ` AND ${scope.join(' AND ')}` : '';

    // 1) EXACT click-id match from the captured vault (last-click revenue).
    // Review fix #2: WITHOUT a vid scope, the same click_id can exist under
    // multiple vids (shared/forwarded ad links, cookie resets) — an unbounded
    // UPDATE would stamp them ALL and double-count one order across visitors
    // (the exact mass-mark DECISIONS #10 forbids). And no-vid IS the default
    // production path today. So: with a vid, match all of THAT visitor's
    // vault rows (reference update_many semantics); without one, stamp at
    // most ONE row — the single most recent matching click.
    if (vals.length) {
      params.push(vals);
      const valIdx = params.length;
      const where = `converted = FALSE AND click_id = ANY($${valIdx})${scopeSql}`;
      const rows = vidClause
        ? await pgQuery(
          `UPDATE lb_clicks
           SET converted = TRUE, session_id = $1, converted_at = NOW()
           WHERE ${where} AND ${vidClause}
           RETURNING id`,
          params
        )
        : await pgQuery(
          `UPDATE lb_clicks
           SET converted = TRUE, session_id = $1, converted_at = NOW()
           WHERE id = (
             SELECT id FROM lb_clicks WHERE ${where}
             ORDER BY ts DESC LIMIT 1
           )
           RETURNING id`,
          params
        );
      if (rows.length) return { stamped: rows.length, mode: 'exact' };
    }

    // 2) No captured click id matched — attribute ONE click (the latest) of
    // the visitor. Requires a vid; without one there is no single visitor to
    // attribute to, so we stop (never mass-mark).
    if (vidList.length) {
      const p2 = [sid, vidList];
      let s2 = '';
      if (funnelId) { p2.push(String(funnelId)); s2 = ` AND funnel_id = $3`; }
      const rows = await pgQuery(
        `UPDATE lb_clicks SET converted = TRUE, session_id = $1, converted_at = NOW()
         WHERE id = (
           SELECT id FROM lb_clicks
           WHERE converted = FALSE AND vid = ANY($2)${s2}
           ORDER BY ts DESC LIMIT 1
         )
         RETURNING id`,
        p2
      );
      if (rows.length) return { stamped: rows.length, mode: 'latest' };
    }
    return { stamped: 0, mode: 'no_match' };
  } catch (err) {
    console.error('[tracking] stampConversion failed (fail-open):', err.message);
    return { stamped: 0, mode: 'error' };
  }
}

export default { CLICK_ID_NETWORK, parseClick, hasBuiltinClick, recordClick, stampConversion, fbclidFromFbc, isValidVid };
