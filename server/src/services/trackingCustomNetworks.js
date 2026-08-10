// Custom S2S networks — the data layer for operator-defined outbound postback
// templates, plus the adapter that lets one ride the EXISTING delivery rails.
//
// A custom network is NOT an lb_pixels row. lb_pixels is UNIQUE (funnel_id,
// kind), so modelling custom networks there would cap an operator at exactly
// ONE per funnel — the opposite of the feature. They live in their own table
// and are projected into a pixel-SHAPED object (asPixel) at dispatch time, so
// trackingDelivery.deliverToPixel keeps its idempotency claim, its circuit
// breaker, its retry queue and its event ledger with no special-casing.
//
// WHAT THE PROJECTION MEANS, FIELD BY FIELD (this is load-bearing):
//   id        → the lbcn_ row id. The breaker scope is `${funnelId}:${id}` and
//               the queue's pixel_row_id, so a custom network gets its OWN
//               breaker and its own queue rows — a flaky partner tracker can
//               never open Meta's breaker.
//   kind      → 'custom'. lb_tracking_events.platform is kind minus '_pixel',
//               so every custom delivery is logged under platform 'custom'.
//   pixel_id  → the IMMUTABLE lbcn_ ROW ID. Review M3 (gating) — this was the
//               operator's label slug, and that was wrong in three ways at
//               once, because pixel_id is half of the lb_tracking_sent
//               (pixel_id, event_id) claim key and that ledger is GLOBAL, not
//               per-funnel:
//                 1. CROSS-FUNNEL SUPPRESSION. Two funnels both with a network
//                    labelled "Partner Alpha" share the slug 'partner-alpha'.
//                    A deterministic event id that collides across them (an
//                    inbound `inb_<order_id>`, a re-used order number) means
//                    funnel B's conversion is silently deduped away by funnel
//                    A's claim. Row ids are unique across the whole table, so
//                    that failure mode does not exist.
//                 2. A RENAME MINTED A NEW IDENTITY, re-opening the claim space
//                    and letting every already-delivered event fire a second
//                    time. Row ids never change.
//                 3. A slug could in principle collide with a real lb_pixels
//                    pixel_id (a Meta pixel id is digits, but nothing enforced
//                    that). The `lbcn_` namespace makes collision impossible.
//               The operator-facing NAME still travels — the label is on every
//               admin surface — it is just not the machine identity.
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureIntegrationsTables } from './trackingIntegrationsSchema.js';
import { validateTemplateShape, MACRO_NAMES } from './trackingPostbackTemplate.js';
import { encryptSecret, decryptSecret } from './gatewayConfigs.js';

// The event vocabulary a custom network may be toggled on for. Deliberately a
// SUPERSET of trackingService.ALLOWED_CLIENT_EVENTS (which gates what a
// BROWSER BEACON may relay): a custom network also serves server-owned money
// events (Purchase) and the inbound-only Refund, neither of which a beacon can
// ever mint.
// PageView is DELIBERATELY ABSENT (seam audit M8). Every delivery takes a
// permanent lb_tracking_sent claim row, and a pageview postback would mint one
// per visitor per page — orders of magnitude more rows than conversions, in a
// table that exists to make conversions exactly-once. A network that genuinely
// wants pageview pings needs a separate, non-claiming path; offering the toggle
// here would have been a promise this delivery layer cannot keep cheaply.
// Rows that already carry it read it out (readEventNames filters to this set).
export const CUSTOM_EVENT_NAMES = [
  'Purchase', 'Lead', 'InitiateCheckout', 'AddPaymentInfo', 'AddToCart',
  'ViewContent', 'CompleteRegistration', 'UpsellView', 'Refund',
];
const CUSTOM_EVENT_SET = new Set(CUSTOM_EVENT_NAMES);

// Money events are SERVER-OWNED. trackingService.ALLOWED_CLIENT_EVENTS already
// refuses to relay these from a browser beacon, but that list governs the RELAY
// as a whole; this one is the custom lane's own belt-and-braces, checked at
// selection so a relayed money event can never even reach a custom sender —
// and therefore can never burn a claim (seam audit B2).
export const SERVER_OWNED_EVENTS = new Set(['Purchase', 'Refund']);

// GENERAL event flags → the event they gate. Un-ticked means NOT SELECTED
// (seam audit M8): before this, the two checkboxes were dead everywhere EXCEPT
// custom networks, which fired the events regardless — so the panel's copy was
// false in the one place it mattered.
export const EVENT_FLAG_GATE = {
  AddToCart: 'fire_addtocart_checkout',
  ViewContent: 'fire_viewcontent_lead',
};

export const CUSTOM_METHODS = ['GET', 'POST'];

// Label → key slug. Same shape as the reference's _cn_slug.
export function slugOf(label) {
  const s = String(label || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 32) || 'custom';
}

// jsonb DISCIPLINE — a column written by an older writer (or hand-inserted)
// can be an object OR a double-encoded JSON string. Every read goes through
// here and degrades a malformed blob to the empty case rather than throwing.
// Same posture as trackingCustomCode.readCustomCode.
export function parseJsonColumn(raw, fallback) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return fallback; }
  }
  if (obj == null) return fallback;
  if (Array.isArray(fallback)) return Array.isArray(obj) ? obj : fallback;
  return (typeof obj === 'object' && !Array.isArray(obj)) ? obj : fallback;
}

// The stored event list, normalised: known names only, de-duped, order-stable.
export function readEventNames(raw) {
  const arr = parseJsonColumn(raw, []);
  const out = [];
  for (const v of arr) {
    const name = String(v || '');
    if (CUSTOM_EVENT_SET.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// Validate + normalise a create/update body. Returns { ok, fields } or
// { ok: false, code }. Only the keys the request actually SET appear in
// `fields`, so a PATCH-style update can never blank a field it never showed.
export function validateNetworkBody(body, { isCreate = false } = {}) {
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : null;
  if (!b) return { ok: false, code: 'invalid_body' };
  const fields = {};

  if (b.label !== undefined || isCreate) {
    const label = String(b.label == null ? '' : b.label).trim();
    if (!label) return { ok: false, code: 'label_required' };
    if (label.length > 60) return { ok: false, code: 'label_too_long' };
    fields.label = label;
    fields.key = slugOf(label);
  }

  if (b.url_template !== undefined || isCreate) {
    const shape = validateTemplateShape(b.url_template);
    if (!shape.ok) return { ok: false, code: shape.code };
    fields.url_template = shape.url;
  }

  if (b.click_id_param !== undefined) {
    const p = String(b.click_id_param == null ? '' : b.click_id_param).trim().toLowerCase();
    // '' is legitimate: a network whose conversions arrive by order id only.
    if (p && !/^[a-z0-9_]{1,32}$/.test(p)) return { ok: false, code: 'invalid_click_id_param' };
    fields.click_id_param = p;
  } else if (isCreate) {
    fields.click_id_param = '';
  }

  if (b.method !== undefined || isCreate) {
    const m = String(b.method == null ? 'GET' : b.method).trim().toUpperCase() || 'GET';
    if (!CUSTOM_METHODS.includes(m)) return { ok: false, code: 'invalid_method' };
    fields.method = m;
  }

  if (b.event_names !== undefined || isCreate) {
    const raw = b.event_names === undefined ? ['Purchase'] : b.event_names;
    if (!Array.isArray(raw)) return { ok: false, code: 'invalid_event_names' };
    if (raw.length > CUSTOM_EVENT_NAMES.length) return { ok: false, code: 'invalid_event_names' };
    const out = [];
    for (const v of raw) {
      const name = String(v == null ? '' : v);
      if (!CUSTOM_EVENT_SET.has(name)) return { ok: false, code: 'unknown_event_name' };
      if (!out.includes(name)) out.push(name);
    }
    fields.event_names = out;
  }

  if (b.enabled !== undefined) {
    // Boolean('false') === true — accept ONLY JSON booleans.
    if (b.enabled !== true && b.enabled !== false) return { ok: false, code: 'invalid_enabled' };
    fields.enabled = b.enabled;
  } else if (isCreate) {
    fields.enabled = true;
  }

  if (!Object.keys(fields).length) return { ok: false, code: 'nothing_to_update' };
  return { ok: true, fields };
}

// ── url_template AT REST (review M2) ────────────────────────────────────────
// The file header calls the rendered URL a credential; a template that carries
// `?api_key=…` or MGID's `/postback/<id>` IS one at rest too, so it is
// encrypted with the same AES-256-GCM mechanism the gateway and pixel
// credentials use (gatewayConfigs.encryptSecret, 'gcm1:' prefix).
//
// LEGACY PASSTHROUGH, deliberately: a value that does NOT start with 'gcm1:'
// is read back unchanged. Nothing has shipped yet so no such rows exist in
// practice, but the same rule already governs lb_pixels secrets
// (trackingDelivery.resolveSecret) and a hand-inserted row must not 500 the
// admin surface.
//
// decryptSecret THROWS on a wrong/rotated CHECKOUT_CREDS_KEY. That throw is
// surfaced as a distinct, RETRYABLE condition rather than swallowed to '' —
// an empty template would read as 'not_configured', which tells the operator
// to go re-type a template that is in fact perfectly fine.
export function readTemplate(raw) {
  const s = String(raw || '');
  if (!s) return '';
  return s.startsWith('gcm1:') ? decryptSecret(s) : s;
}
const writeTemplate = (plain) => encryptSecret(String(plain));

// What a LIST response and the card grid may show: the host the postbacks go
// to, and WHICH macros the template uses — never the path, query or fragment,
// which is exactly where a credential sits. Enough to recognise a network at a
// glance and to see that it is wired; not enough to lift a key off a screen
// share or a browser cache.
export function templateSummary(plain) {
  const s = String(plain || '');
  let host = '';
  try { host = new URL(s).host; } catch { host = ''; }
  const macros = [];
  for (const m of s.matchAll(/\{([a-z0-9_]{1,24})\}/g)) {
    if (MACRO_NAMES.includes(m[1]) && !macros.includes(m[1])) macros.push(m[1]);
  }
  return { url_host: host, url_macros: macros };
}

// The operator-facing view of one row.
//
// `reveal` is FALSE by default and every LIST goes through the default. The
// full template is returned ONLY by the single-row GET that backs the edit
// form — an operator cannot edit what they cannot see, but nothing else needs
// it, and a list endpoint that hands back N credentials at once is the shape
// that ends up in a browser cache or a support screenshot.
export function networkView(row, { reveal = false } = {}) {
  if (!row) return null;
  let plain = '';
  let decryptFailed = false;
  try { plain = readTemplate(row.url_template); } catch { decryptFailed = true; }
  const out = {
    id: row.id,
    funnel_id: row.funnel_id,
    key: row.key,
    label: row.label || '',
    click_id_param: row.click_id_param || '',
    method: row.method || 'GET',
    event_names: readEventNames(row.event_names),
    enabled: Boolean(row.enabled),
    // Which directory preset minted this row, or '' for a hand-made one. The
    // client matches preset cards on THIS, never on a re-derived slug.
    preset_key: row.preset_key || '',
    ...templateSummary(plain),
    // Encrypted at rest, and the operator is told so — a stored secret they
    // do not know is stored is a secret they cannot reason about.
    url_template_encrypted: String(row.url_template || '').startsWith('gcm1:'),
    ...(decryptFailed ? { url_template_unreadable: true } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (reveal) out.url_template = decryptFailed ? '' : plain;
  return out;
}

const SELECT_COLS = `id, funnel_id, key, label, click_id_param, url_template,
                     method, event_names, enabled, preset_key, created_at, updated_at`;

export async function listNetworks(funnelId) {
  await ensureIntegrationsTables();
  return pgQuery(
    `SELECT ${SELECT_COLS} FROM lb_custom_networks WHERE funnel_id = $1 ORDER BY created_at ASC`,
    [String(funnelId)]
  );
}

export async function getNetwork(funnelId, id) {
  await ensureIntegrationsTables();
  const rows = await pgQuery(
    `SELECT ${SELECT_COLS} FROM lb_custom_networks WHERE funnel_id = $1 AND id = $2`,
    [String(funnelId), String(id)]
  );
  return rows.length ? rows[0] : null;
}

export async function createNetwork(funnelId, fields) {
  await ensureIntegrationsTables();
  const id = `lbcn_${crypto.randomBytes(9).toString('hex')}`;
  // event_names is passed as a RAW ARRAY. pgQuery (postgres.js) serialises
  // jsonb params itself; pre-stringifying stores a jsonb STRING scalar and
  // every later jsonb operator throws on it.
  const rows = await pgQuery(
    `INSERT INTO lb_custom_networks
       (id, funnel_id, key, label, click_id_param, url_template, method, event_names, enabled, preset_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     ON CONFLICT (funnel_id, key) DO NOTHING
     RETURNING ${SELECT_COLS}`,
    [id, String(funnelId), fields.key, fields.label, fields.click_id_param || '',
      writeTemplate(fields.url_template), fields.method || 'GET', fields.event_names || [],
      fields.enabled !== false, fields.preset_key || null]
  );
  return rows.length ? rows[0] : null; // null = the (funnel, key) already exists
}

// Partial update. Builds the SET list from the keys the request actually sent,
// so an omitted field keeps its stored value.
export async function updateNetwork(funnelId, id, fields) {
  await ensureIntegrationsTables();
  const sets = [];
  const params = [String(funnelId), String(id)];
  const put = (col, val, cast = '') => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (fields.label !== undefined) { put('label', fields.label); put('key', fields.key); }
  if (fields.click_id_param !== undefined) put('click_id_param', fields.click_id_param);
  if (fields.url_template !== undefined) put('url_template', writeTemplate(fields.url_template));
  if (fields.method !== undefined) put('method', fields.method);
  if (fields.event_names !== undefined) put('event_names', fields.event_names, '::jsonb');
  if (fields.enabled !== undefined) put('enabled', fields.enabled);
  if (!sets.length) return getNetwork(funnelId, id);
  const rows = await pgQuery(
    `UPDATE lb_custom_networks SET ${sets.join(', ')}, updated_at = NOW()
     WHERE funnel_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    params
  );
  return rows.length ? rows[0] : null;
}

export async function deleteNetwork(funnelId, id) {
  await ensureIntegrationsTables();
  const rows = await pgQuery(
    `DELETE FROM lb_custom_networks WHERE funnel_id = $1 AND id = $2 RETURNING id`,
    [String(funnelId), String(id)]
  );
  return rows.length > 0;
}

// Project one custom-network row into the pixel-shaped object the delivery
// layer consumes. See the header for what each field means downstream.
export function asPixel(row) {
  if (!row) return null;
  let template = '';
  let decryptFailed = false;
  try {
    template = readTemplate(row.url_template);
  } catch {
    // Wrong/rotated CHECKOUT_CREDS_KEY or corrupt ciphertext. NOT collapsed to
    // '' — that reads as 'not_configured', a HARD error that dead-letters the
    // conversion and tells the operator to re-type a template that is fine.
    // The sender turns this flag into a RETRYABLE 'template_decrypt_failed',
    // so fixing the key heals the queued backlog (queue rows re-read the row
    // at send time). The ciphertext is never logged in any branch.
    decryptFailed = true;
  }
  return {
    id: row.id,
    funnel_id: row.funnel_id,
    kind: 'custom',
    // The IMMUTABLE row id — see the header. Half of the lb_tracking_sent
    // claim key, and that ledger is global, so this must not be the label.
    pixel_id: row.id,
    mode: 's2s',                 // a postback template has no browser channel
    enabled: Boolean(row.enabled),
    config: {
      url_template: template,
      template_decrypt_failed: decryptFailed,
      method: row.method || 'GET',
      click_id_param: row.click_id_param || '',
      label: row.label || '',
      event_names: readEventNames(row.event_names),
    },
  };
}

// The custom networks that should receive ONE named event on ONE funnel.
//
// DECISION — the per-event toggle filters at SELECTION, not inside the sender.
// A network toggled OFF for an event must not take an lb_tracking_sent claim
// (the claim key is (pixel_id, event_id) and burning it would permanently
// suppress a later re-fire of that same event if the operator toggles the
// event back on), and it must not write a 'skipped' ledger row for an event it
// was never asked to send — that would drown the real skips. An untoggled
// event is a NON-EVENT for that network, not a refusal.
export async function customNetworksFor(funnelId, eventName, { source = '', flags = {} } = {}) {
  const name = String(eventName || '');
  // B2: a client-relayed money event selects NOTHING. Purchase and Refund are
  // owned by the settlement path; a beacon that somehow reached this call has
  // no business driving a partner postback, and refusing at SELECTION means no
  // claim row is burned either (a burned claim would suppress the REAL
  // server-side conversion for that event id, permanently).
  if (String(source) === 'relay' && SERVER_OWNED_EVENTS.has(name)) return [];
  // M8: the GENERAL panel's fire-flags actually gate now. Un-ticked = the
  // event is not sent to custom networks at all.
  const gate = EVENT_FLAG_GATE[name];
  if (gate && (flags || {})[gate] !== true) return [];
  const rows = await listNetworks(funnelId);
  return rows
    .filter((r) => r.enabled && readEventNames(r.event_names).includes(name))
    .map(asPixel);
}

// The enabled custom networks' click-id parameters for one funnel — the list
// the click-vault parser needs so a visitor arriving on a custom network's own
// parameter is actually recorded (seam audit MINOR).
//
// CACHED, because unlike every other read in this module the caller is the
// PUBLIC /track/click beacon: one landing = one call, on a surface with no
// authentication and no natural rate ceiling beyond the per-IP limiter. A
// 60-second TTL means an operator's new click parameter is live within a
// minute, which is well inside how long it takes them to go paste it into a
// campaign URL, and the steady-state cost is zero queries.
const CLICK_PARAM_TTL_MS = 60_000;
const clickParamCache = new Map(); // funnelId → { at, params }

export async function customClickParams(funnelId) {
  const key = String(funnelId || '');
  const hit = clickParamCache.get(key);
  if (hit && Date.now() - hit.at < CLICK_PARAM_TTL_MS) return hit.params;
  await ensureIntegrationsTables();
  const rows = await pgQuery(
    `SELECT click_id_param FROM lb_custom_networks
     WHERE funnel_id = $1 AND enabled = TRUE AND click_id_param <> ''`,
    [key]
  );
  const params = rows.map((r) => String(r.click_id_param || '').toLowerCase()).filter(Boolean);
  clickParamCache.set(key, { at: Date.now(), params });
  // Bounded: a dashboard with thousands of funnels must not grow this map
  // without limit. Oldest-out is fine — a miss is one cheap query.
  if (clickParamCache.size > 500) {
    const oldest = [...clickParamCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) clickParamCache.delete(oldest[0]);
  }
  return params;
}

// Test seam: the 60s TTL would otherwise make a harness assert stale data.
export const _clearClickParamCache = () => clickParamCache.clear();

// Re-read one custom network AS A PIXEL by its row id — the drain's resolver
// (a queued row re-reads its target at send time so a fixed template heals the
// backlog, the same rule lb_pixels rows get).
export async function customNetworkPixelById(rowId) {
  await ensureIntegrationsTables();
  const rows = await pgQuery(
    `SELECT ${SELECT_COLS} FROM lb_custom_networks WHERE id = $1`,
    [String(rowId)]
  );
  return rows.length ? asPixel(rows[0]) : null;
}

export default {
  CUSTOM_EVENT_NAMES, CUSTOM_METHODS, slugOf, parseJsonColumn, readEventNames,
  SERVER_OWNED_EVENTS, EVENT_FLAG_GATE,
  validateNetworkBody, networkView, listNetworks, getNetwork, createNetwork,
  updateNetwork, deleteNetwork, asPixel, customNetworksFor, customNetworkPixelById,
  readTemplate, templateSummary, customClickParams,
};
