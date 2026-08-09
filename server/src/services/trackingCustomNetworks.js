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
//   pixel_id  → the network KEY (the label slug), NOT the row id. This is the
//               lb_tracking_sent claim key together with event_id, so renaming
//               a network re-opens its claim space; that is deliberate and
//               documented in the admin surface (a rename is a new identity).
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureIntegrationsTables } from './trackingIntegrationsSchema.js';
import { validateTemplateShape } from './trackingPostbackTemplate.js';

// The event vocabulary a custom network may be toggled on for. Deliberately a
// SUPERSET of trackingService.ALLOWED_CLIENT_EVENTS (which gates what a
// BROWSER BEACON may relay): a custom network also serves server-owned money
// events (Purchase) and the inbound-only Refund, neither of which a beacon can
// ever mint.
export const CUSTOM_EVENT_NAMES = [
  'Purchase', 'Lead', 'InitiateCheckout', 'AddPaymentInfo', 'AddToCart',
  'ViewContent', 'CompleteRegistration', 'UpsellView', 'PageView', 'Refund',
];
const CUSTOM_EVENT_SET = new Set(CUSTOM_EVENT_NAMES);

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

// The operator-facing view of one row. The url_template IS returned — it is
// the operator's own text and they cannot edit what they cannot see. It must
// never travel anywhere else (no logs, no error columns, no event feed).
export function networkView(row) {
  if (!row) return null;
  return {
    id: row.id,
    funnel_id: row.funnel_id,
    key: row.key,
    label: row.label || '',
    click_id_param: row.click_id_param || '',
    url_template: row.url_template || '',
    method: row.method || 'GET',
    event_names: readEventNames(row.event_names),
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT_COLS = `id, funnel_id, key, label, click_id_param, url_template,
                     method, event_names, enabled, created_at, updated_at`;

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
       (id, funnel_id, key, label, click_id_param, url_template, method, event_names, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (funnel_id, key) DO NOTHING
     RETURNING ${SELECT_COLS}`,
    [id, String(funnelId), fields.key, fields.label, fields.click_id_param || '',
      fields.url_template, fields.method || 'GET', fields.event_names || [],
      fields.enabled !== false]
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
  if (fields.url_template !== undefined) put('url_template', fields.url_template);
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
  return {
    id: row.id,
    funnel_id: row.funnel_id,
    kind: 'custom',
    pixel_id: row.key,
    mode: 's2s',                 // a postback template has no browser channel
    enabled: Boolean(row.enabled),
    config: {
      url_template: row.url_template || '',
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
export async function customNetworksFor(funnelId, eventName) {
  const rows = await listNetworks(funnelId);
  const name = String(eventName || '');
  return rows
    .filter((r) => r.enabled && readEventNames(r.event_names).includes(name))
    .map(asPixel);
}

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
  validateNetworkBody, networkView, listNetworks, getNetwork, createNetwork,
  updateNetwork, deleteNetwork, asPixel, customNetworksFor, customNetworkPixelById,
};
