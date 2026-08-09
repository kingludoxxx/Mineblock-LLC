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

// ── Device classification (ANALYTICS LANE 5) ────────────────────────────────
// EXACT port of the reference's lb_page_stats_service.classify_device
// (funnel-os backend/app/services/lb_page_stats_service.py:164-183) — the same
// five classes, the same marker list, the same ORDER. A Puure device card and
// a funnel-os device card must never disagree about what "tablet" means.
//
// Properties inherited deliberately from the reference:
//   • BOT IS TESTED FIRST. A crawler UA that also says "Android" is a bot, not
//     a mobile. Crawler load is routinely the majority of hits right after an
//     ad goes live; classifying it as mobile would poison every device rate.
//   • iPadOS 13+ masquerades as Macintosh and therefore lands in DESKTOP. That
//     is an accepted, industry-wide blind spot, documented — not a bug to fix
//     with a heuristic that would misfile real Macs.
//   • An empty/absent UA is 'unknown', NEVER 'desktop'. Missing is not desktop.
//   • The marker list OVER-matches on purpose: "monitor" and "preview" catch
//     link-preview fetchers, at the cost of misfiling a device model that
//     contains one of those substrings (the reference records the same trade
//     at listicle_builders.py:9203-9209 — the "CUBOT" phone is its example).
//     The reference therefore pairs this classifier with a stricter regex
//     wherever a bot verdict SUPPRESSES money. Nothing here suppresses money:
//     lb_touches.device is descriptive only, so the loose list is correct here.
export const DEVICE_CLASSES = Object.freeze(['desktop', 'mobile', 'tablet', 'bot', 'unknown']);
const BOT_MARKERS = Object.freeze([
  'bot', 'crawler', 'spider', 'curl', 'wget', 'python-requests',
  'headless', 'lighthouse', 'facebookexternalhit', 'preview',
  'monitor', 'pingdom',
]);

export function classifyDevice(ua) {
  const u = String(ua == null ? '' : ua).toLowerCase();
  if (!u) return 'unknown';
  if (BOT_MARKERS.some((m) => u.includes(m))) return 'bot';
  if (u.includes('ipad') || u.includes('tablet') || (u.includes('android') && !u.includes('mobile'))) return 'tablet';
  if (u.includes('iphone') || u.includes('mobi') || u.includes('android')) return 'mobile';
  return 'desktop';
}

// ── Country (ANALYTICS LANE 5) — CODE ONLY, THE IP IS NEVER PERSISTED ───────
// Port of the reference's lb_page_stats_service.norm_country: validate to an
// ISO-3166 alpha-2 key or nothing. Cloudflare emits XX (unknown) and T1 (Tor);
// both drop to '' (T1 fails the alpha test, XX is named explicitly).
export function normCountry(cc) {
  const c = String(cc == null ? '' : cc).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : '';
}

// The IP is an INPUT, never an output. It exists only inside this function's
// stack frame: it is not returned, not stored, and never interpolated into a
// log line or an error message (asserted by the harness's grep-proof).
function toIpv4(ip) {
  let s = String(ip == null ? '' : ip).trim();
  if (!s) return '';
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
  // IPv4-mapped IPv6 (::ffff:203.0.113.5) — Node hands these back on a
  // dual-stack listener; the lookup table only knows the bare v4 form.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  // Strip a trailing :port, but ONLY when what remains is a v4 address (an
  // IPv6 address is all colons — chopping its last group would forge an IP).
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(s);
  if (withPort) s = withPort[1];
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return ''; // IPv6 or malformed ⇒ unresolvable HERE (see resolver note)
  for (let i = 1; i <= 4; i++) if (Number(m[i]) > 255) return '';
  return s;
}

// The resolver seam. Default: lazily load the optional `ip3country` package
// (zero-dependency, ~470KB pure-JS IP2Location LITE country table). The
// package is OPTIONAL BY DESIGN — if it is not installed the resolver returns
// nothing and country stays NULL, which is the honest answer. It is never a
// crash and never a guess.
//
// KNOWN COVERAGE LIMIT (must be disclosed by every reading surface):
// ip3country is IPv4-ONLY. An IPv6 visitor resolves to NULL, so a by-country
// card is a sample of the IPv4 population, not a census. Where an edge geo
// header is available it is preferred precisely because it has no such gap.
let _resolver = null;        // operator/harness override
let _resolverLoad = null;    // single-flight lazy load of the default
let _warnedResolver = false;

// An error MESSAGE is untrusted text. The resolver is third-party code (or an
// operator-injected function) and it is handed an IP — so its throw can quote
// that IP straight back at us, and logging the message verbatim would persist
// the one value this whole design exists to keep out of storage. Caught by
// the harness (device-geo.mjs T7), which throws an IP-bearing message on
// purpose. Redact before anything reaches a log sink.
function scrubIp(msg) {
  return String(msg == null ? '' : msg)
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})\b/gi, '[redacted-ip]');
}

/** Inject a country resolver: `(ipv4) => 'ES' | '' | Promise<…>`. Pass null to restore the default. */
export function setCountryResolver(fn) {
  _resolver = typeof fn === 'function' ? fn : null;
  _resolverLoad = null;
  _warnedResolver = false;
}

function loadDefaultResolver() {
  if (!_resolverLoad) {
    _resolverLoad = import('ip3country')
      .then((mod) => {
        const lib = mod?.default || mod;
        if (!lib || typeof lib.lookupStr !== 'function') return null;
        lib.init();
        return lib;
      })
      .catch((err) => {
        // NOT a silent failure: say it once, then degrade to NULL country.
        // The message is the module resolution error — it can never carry a
        // visitor IP, because no IP is in scope here.
        console.warn('[tracking] country resolution disabled — optional dependency `ip3country` not loaded:', scrubIp(err.message));
        return null;
      });
  }
  return _resolverLoad;
}

/**
 * Resolve a visitor's country to an ISO-3166 alpha-2 code, or '' when it
 * cannot be known. Precedence:
 *   1. an EDGE GEO HEADER (cf-ipcountry) — exact, IPv6-safe, free. This is
 *      what the reference uses everywhere. Puure's own Cloudflare DNS records
 *      are created with proxied:false (domainHub/cloudflareDns.js:74), so the
 *      header does NOT arrive today — but it costs nothing and starts working
 *      the moment a zone is proxied, so it is checked first.
 *   2. the IP lookup table, IPv4 only.
 * NEVER THROWS and never returns anything derived from the IP but the code.
 */
export async function resolveCountry({ countryHeader = '', ip = '' } = {}) {
  const fromHeader = normCountry(countryHeader);
  if (fromHeader) return fromHeader;
  const v4 = toIpv4(ip);
  if (!v4) return '';
  try {
    if (_resolver) return normCountry(await _resolver(v4));
    const lib = await loadDefaultResolver();
    if (!lib) return '';
    return normCountry(lib.lookupStr(v4));
  } catch (err) {
    if (!_warnedResolver) {
      _warnedResolver = true;
      console.error('[tracking] country resolver failed (fail-open, country stays NULL):', scrubIp(err.message));
    }
    return '';
  }
}

// Record one pageview touch. Collapses same-url refresh replays inside a 45s
// window into one row (refresh spam, back/forward cache). Fail-open: any error
// is swallowed — a tracking failure must never break the page.
//
// LANE 5 opts — `ua`, `ip`, `countryHeader`. KEY PRESENCE IS THE SIGNAL:
// an ABSENT `ua` key means the caller does not capture the UA at all, so
// device is written NULL ("not captured"). A PRESENT-but-empty `ua` means the
// request genuinely had none, so device is 'unknown' ("captured, said
// nothing"). Same rule for geo: no `ip`/`countryHeader` key ⇒ country NULL.
// Without that distinction an unwired caller would fill the column with
// 'unknown' and a card would render 100% unknown as if it were measurement.
//
// ⚠️ THE SEAM IS NOT WIRED YET. routes/trackingPublic.js:140 is the only
// caller and it is OUTSIDE this lane's fence, so it still calls the 5-arg
// form and every new row lands device=NULL, country=NULL. The integrator's
// change is exactly this, using locals that already exist in that file
// (clientIp() at :35, which is req.ip and therefore the X-Forwarded-For first
// hop because app.js:40 sets `trust proxy 1` — the SAME derivation the rate
// limiter and ipHash already use, so device/geo can never disagree with them
// about who the client is):
//
//     recordTouch(funnelId, pageOf(b), b.vid, url, ref, {
//       ua: req.get('user-agent') || '',
//       ip: clientIp(req),
//       countryHeader: req.get('cf-ipcountry') || '',
//     }),
//
// Note the UA is taken from the REQUEST, never from the body — the same rule
// /collect already follows at :188-194 ("Never trust client IP/UA for
// identity — take them from the request itself").
export async function recordTouch(funnelId, pageId, vid, url, referrer, opts = {}) {
  if (!isValidVid(vid)) return { ok: false, reason: 'bad_vid' };
  const { customParams = [] } = opts;
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

    // LANE 5 — classify + resolve. `device` is a bounded class from a frozen
    // list; `country` is two letters or nothing. The raw IP dies with this
    // stack frame: it is not in the parameter array, not in the row, not in a
    // log line. NULL when the caller does not supply the input at all.
    const device = 'ua' in opts ? classifyDevice(opts.ua) : null;
    const country = ('ip' in opts || 'countryHeader' in opts)
      ? (await resolveCountry(opts)) || null
      : null;

    await pgQuery(
      `INSERT INTO lb_touches (vid, funnel_id, page_id, url, referrer, utm, click_ids, device, country, ts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
      [
        vid, String(funnelId || ''), pageId ? String(pageId).slice(0, 64) : null,
        cappedUrl, String(referrer || '').slice(0, 300),
        utmOf(url), clickIds, device, country,
        new Date(Date.now() + TOUCH_TTL_MS),
      ]
    );
    return { ok: true, network: parsed?.network || '', device, country };
  } catch (err) {
    console.error('[tracking] recordTouch failed (fail-open):', scrubIp(err.message));
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

export default {
  recordTouch, recordFirstSeen, emqScore, EMQ_WEIGHTS, PLATFORM_IDENTITY_KEYS, idkFrom,
  classifyDevice, normCountry, resolveCountry, setCountryResolver, DEVICE_CLASSES,
};
