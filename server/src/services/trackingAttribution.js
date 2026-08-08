// Touches + first-seen registry + match-quality scoring — port of funnel-os
// lb_attribution_service.py and the EMQ block of lb_tracking_service.py.
import { pgQuery } from '../db/pg.js';
import { ensureTrackingTables } from './trackingSchema.js';
import { parseClick, isValidVid } from './trackingClicks.js';

const TOUCH_TTL_MS = 90 * 24 * 3600 * 1000;
const DEDUP_WINDOW_S = 45; // same visitor + same url inside 45s collapse to one

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function utmOf(url) {
  const out = {};
  try {
    const u = new URL(String(url || ''), 'http://x');
    for (const k of UTM_KEYS) {
      const v = u.searchParams.get(k);
      if (v) out[k] = String(v).slice(0, 200);
    }
  } catch { /* fail-open */ }
  return out;
}

// Record one pageview touch. Collapses same-url refresh replays inside a 45s
// window into one row (refresh spam, back/forward cache). Fail-open: any error
// is swallowed — a tracking failure must never break the page.
export async function recordTouch(funnelId, pageId, vid, url, referrer, { customParams = [] } = {}) {
  if (!isValidVid(vid)) return { ok: false, reason: 'bad_vid' };
  try {
    await ensureTrackingTables();
    const cappedUrl = String(url || '').slice(0, 480);
    // Collapse refresh replays: same visitor + same url inside the window.
    const recent = await pgQuery(
      `SELECT 1 FROM lb_touches
       WHERE vid = $1 AND url = $2 AND ts > NOW() - INTERVAL '${DEDUP_WINDOW_S} seconds'
       LIMIT 1`,
      [vid, cappedUrl]
    );
    if (recent.length) return { ok: true, deduped: true };

    const parsed = parseClick(url, customParams);
    const clickIds = parsed ? { [parsed.click_key]: parsed.click_id } : {};
    await pgQuery(
      `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, click_ids, ts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
      [
        vid, String(funnelId || ''), pageId ? String(pageId).slice(0, 64) : null,
        cappedUrl, String(referrer || '').slice(0, 300),
        utmOf(url), clickIds, new Date(Date.now() + TOUCH_TTL_MS),
      ]
    );
    return { ok: true, network: parsed?.network || '' };
  } catch (err) {
    console.error('[tracking] recordTouch failed (fail-open):', err.message);
    return { ok: false };
  }
}

// Write-once acquisition registry (DECISIONS #9). NO expiry. The vid is the
// PK; ON CONFLICT DO NOTHING makes it $setOnInsert-equivalent — a returning
// visitor's first-touch context can never be overwritten by a later touch.
export async function recordFirstSeen(funnelId, vid, url, { customParams = [] } = {}) {
  if (!isValidVid(vid)) return { ok: false };
  try {
    await ensureTrackingTables();
    const parsed = parseClick(url, customParams);
    const firstCtx = parsed
      ? { ...parsed.struct, ...parsed.utm, click_key: parsed.click_key }
      : utmOf(url);
    const rows = await pgQuery(
      `INSERT INTO lb_visitor_firstseen (vid, funnel_id, network, first_ctx, first_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (vid) DO NOTHING
       RETURNING vid`,
      [vid, String(funnelId || ''), parsed?.network || 'direct', firstCtx]
    );
    return { ok: true, new_visitor: rows.length > 0 };
  } catch (err) {
    console.error('[tracking] recordFirstSeen failed (fail-open):', err.message);
    return { ok: false };
  }
}

// ── Match-quality (EMQ) — port of lb_tracking_service.emq_score ──────────────
// Weights follow Meta's published contribution ordering. Computed from the
// PII-free `idk` key list (which identity signals were present), never PII.
export const EMQ_WEIGHTS = {
  em: 3.0, ph: 2.5, fbc: 2.0, click_id: 2.0, fbp: 1.0,
  external_id: 0.75, ip: 0.5, ua: 0.5, fn: 0.5, ln: 0.5,
  ct: 0.35, st: 0.35, zp: 0.35, country: 0.3,
};
// The five headline identifiers Meta weights most normalise the scale (9.25).
const EMQ_HEADLINE =
  EMQ_WEIGHTS.em + EMQ_WEIGHTS.ph + EMQ_WEIGHTS.fbp + EMQ_WEIGHTS.fbc + EMQ_WEIGHTS.external_id;

// Per-event EMQ, integer 0..10. The click-id family (fbc / click_id) counts
// ONCE; every other present signal adds its match weight.
export function emqScore(idk) {
  const keys = new Set(idk || []);
  let total = 0;
  if (keys.has('fbc') || keys.has('click_id')) {
    total += EMQ_WEIGHTS.fbc;
    keys.delete('fbc');
    keys.delete('click_id');
  }
  for (const k of keys) total += EMQ_WEIGHTS[k] || 0;
  return Math.max(0, Math.min(10, Math.round((total / EMQ_HEADLINE) * 10)));
}

// Which identity keys each platform's server payload can actually use — the
// score is normalised per platform so a click-id-only network isn't punished
// for keys its API doesn't accept.
export const PLATFORM_IDENTITY_KEYS = {
  meta: ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'fbp', 'fbc', 'ip', 'ua', 'external_id'],
  tiktok: ['em', 'ph', 'external_id', 'click_id', 'ip', 'ua'],
  snapchat: ['em', 'ph', 'ip', 'ua', 'click_id'],
  pinterest: ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'ip', 'ua', 'click_id'],
  google_ads_conversion: ['click_id', 'em', 'fn', 'ln', 'ct', 'st', 'zp', 'country'],
  reddit: ['em', 'ph', 'ip', 'ua', 'click_id'],
  linkedin: ['em', 'click_id'],
  taboola: ['click_id'], outbrain: ['click_id'], mgid: ['click_id'],
  revcontent: ['click_id'], newsbreak: ['click_id'],
};

// Build the PII-free idk list from a set of present identity signals.
export function idkFrom({ em, ph, fbp, fbc, click_id, external_id, ip, ua, fn, ln, ct, st, zp, country } = {}) {
  const out = [];
  const add = (v, k) => { if (v) out.push(k); };
  add(em, 'em'); add(ph, 'ph'); add(fbp, 'fbp'); add(fbc, 'fbc'); add(click_id, 'click_id');
  add(external_id, 'external_id'); add(ip, 'ip'); add(ua, 'ua'); add(fn, 'fn'); add(ln, 'ln');
  add(ct, 'ct'); add(st, 'st'); add(zp, 'zp'); add(country, 'country');
  return out;
}

export default { recordTouch, recordFirstSeen, emqScore, EMQ_WEIGHTS, PLATFORM_IDENTITY_KEYS, idkFrom };
