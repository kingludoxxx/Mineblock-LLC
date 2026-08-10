// Outbound postback TEMPLATE ENGINE — the macro renderer + the save-time
// template validator for operator-defined custom S2S networks.
//
// Port of the funnel-os postback template engine (lb_tracking_service.
// render_postback / postback_context) with the SSRF hole closed. Pure
// functions only: no database, no network, no environment reads — so the
// macro-expansion and refusal rules are testable without Postgres.
//
// ── THE MACRO CONTRACT ──────────────────────────────────────────────────────
// A template is a URL with {macro} placeholders:
//   https://track.example.com/pb?cid={click_id}&amt={payout}&cur={currency}
// Every macro value is URL-ENCODED with encodeURIComponent before it is
// substituted, so a hostile value can never add a query parameter, escape the
// path, or inject a fragment. Unknown macros render EMPTY — a tracker
// convention (networks ignore empty params), and strictly safer than leaving
// the literal `{macro}` on the wire.
//
// SINGLE PASS, ON PURPOSE. String.prototype.replace with a function callback
// never rescans its own output, so a macro whose VALUE contains `{payout}`
// cannot cause a second expansion. This is the difference between a value the
// operator's network echoes back and a template-injection primitive.
import net from 'net';

// Macro names: lower snake, 1-24 chars. Anything else is not a macro and is
// left alone — an operator's literal `{}` in a path stays literal.
const MACRO_RE = /\{([a-z0-9_]{1,24})\}/g;

// The macro names the context always defines. Exported so the UI can show the
// operator exactly what is available rather than making them guess.
export const MACRO_NAMES = [
  'click_id', 'click_key', 'network', 'event', 'event_id', 'value', 'payout',
  'currency', 'order_id', 'status', 'vid', 'funnel', 'funnel_id', 'page_url',
  'timestamp',
  ...Array.from({ length: 10 }, (_, i) => `sub${i + 1}`),
];

// Render one template against one context.
//
// The context is read with Object.prototype.hasOwnProperty.call, NOT `ctx[k]`:
// `{constructor}` / `{tostring}` would otherwise resolve to a function through
// the prototype chain and String() it onto the wire. Only OWN enumerable keys
// are macros.
export function renderPostback(template, ctx) {
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  return String(template == null ? '' : template).replace(MACRO_RE, (_m, name) => {
    if (!Object.prototype.hasOwnProperty.call(c, name)) return '';
    const val = c[name];
    if (val == null) return '';
    // Objects/arrays/functions are not renderable values — a template that
    // names one gets an empty string, never '[object Object]' on the wire.
    if (typeof val === 'object' || typeof val === 'function') return '';
    return encodeURIComponent(String(val));
  });
}

// The largest payout a postback may carry. Matches trackingInbound.MAX_PAYOUT
// — the same number bounding the same quantity arriving from the other
// direction. A value above this is a malformed feed or a forged beacon, not a
// sale, and a network that books it corrupts the operator's ROAS.
export const MAX_POSTBACK_VALUE = 1_000_000;

// Round a money value to 2dp, or '' when there is nothing honest to send.
// NaN / Infinity / null / '' all render EMPTY rather than 'NaN' — a tracker
// that receives `payout=NaN` books a garbage conversion.
//
// NEGATIVE and ABSURD values render EMPTY too (seam audit B2). This is the
// last line rather than the first: the custom sender allow-lists and bounds
// custom_data before it ever gets here, but a beacon-supplied value reaches
// this function through more than one path and an omitted parameter is always
// safer than a wrong number on the wire.
function money(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n < 0 || n > MAX_POSTBACK_VALUE) return '';
  return (Math.round(n * 100) / 100).toFixed(2);
}

// Build the macro dictionary for one event. Returns a NULL-PROTOTYPE object so
// there is no inherited key for a template to reach.
export function postbackContext({
  eventName = '', eventId = '', clickId = '', clickKey = '', network = '',
  value = null, currency = '', orderId = '', status = '', vid = '',
  funnel = '', funnelId = '', pageUrl = '', subs = null, nowMs = null,
} = {}) {
  const ctx = Object.create(null);
  const m = money(value);
  ctx.click_id = String(clickId || '');
  ctx.click_key = String(clickKey || '');
  ctx.network = String(network || '');
  ctx.event = String(eventName || '').toLowerCase();
  ctx.event_id = String(eventId || '');
  ctx.value = m;
  ctx.payout = m;
  ctx.currency = String(currency || '').toUpperCase();
  ctx.order_id = String(orderId || '');
  ctx.status = String(status || 'approved');
  ctx.vid = String(vid || '');
  ctx.funnel = String(funnel || '');
  ctx.funnel_id = String(funnelId || '');
  ctx.page_url = String(pageUrl || '');
  ctx.timestamp = String(Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000));
  const s = (subs && typeof subs === 'object') ? subs : {};
  for (let i = 1; i <= 10; i += 1) {
    const k = `sub${i}`;
    const v = Object.prototype.hasOwnProperty.call(s, k) ? s[k] : '';
    ctx[k] = (v == null || typeof v === 'object' || typeof v === 'function') ? '' : String(v);
  }
  return ctx;
}

// ── SAVE-TIME TEMPLATE VALIDATION ───────────────────────────────────────────
// The fire-time guard (trackingDelivery.endpointAllowed) resolves the RENDERED
// url's host and refuses private/loopback/link-local answers. That guard is
// necessary but it is NOT sufficient on its own for a template, because of one
// specific shape:
//
//     https://{click_id}.attacker.example/  →  the HOST is attacker-controlled
//
// A macro in the authority means the host that gets validated at save time is
// not the host that gets contacted at fire time, and an inbound click id could
// steer every conversion at a different origin on every fire. So a macro is
// REFUSED anywhere in the scheme, userinfo, host or port. Macros in the path,
// query and fragment are the entire point of the feature and stay allowed.
//
// Userinfo is refused outright for the same class of reason:
// `https://trusted.example@169.254.169.254/` reads as trusted to a human and
// resolves to cloud metadata.
//
// Returns { ok: true, url } or { ok: false, code }.
export function validateTemplateShape(template) {
  const raw = String(template == null ? '' : template).trim();
  if (!raw) return { ok: false, code: 'template_required' };
  if (raw.length > 2048) return { ok: false, code: 'template_too_long' };
  // Control characters (incl. CR/LF) in a URL are a request-splitting shape
  // and cannot appear in a legitimate template.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, code: 'template_control_chars' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: 'template_not_a_url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, code: 'template_bad_scheme' };
  }
  if (u.username || u.password) return { ok: false, code: 'template_userinfo' };
  // The authority must be fully literal. WHATWG URL has already lowercased and
  // punycoded the hostname by here, so this reads the value that will actually
  // be resolved — not the operator's raw bytes.
  if (/[{}]/.test(u.hostname) || /[{}]/.test(u.port)) {
    return { ok: false, code: 'template_macro_in_host' };
  }
  if (!u.hostname) return { ok: false, code: 'template_no_host' };
  return { ok: true, url: raw };
}

// True when the hostname is a bare IP literal. Used only to explain a refusal
// in operator prose — the actual refusal comes from the SSRF guard.
export function isIpHost(template) {
  try {
    const h = new URL(String(template || '')).hostname.replace(/^\[|\]$/g, '');
    return net.isIP(h) !== 0;
  } catch {
    return false;
  }
}

export default {
  MACRO_NAMES, renderPostback, postbackContext, validateTemplateShape, isIpHost,
};
