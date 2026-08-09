// INBOUND postbacks — the tokenized endpoints ad networks, call centres and
// partner funnels call back INTO us. Port of funnel-os lb_inbound_service.py,
// with the token compare hardened and the anti-probing rule made absolute.
//
// SCOPE, DELIBERATELY NARROW (DECISION): an ingest writes lb_inbound_events
// and NOTHING ELSE. It does not touch lb_clicks / lb_touches /
// lb_visitor_firstseen, does not call stampConversion, and does not relay the
// conversion back out. The reference relays inbound events straight into the
// outbound dispatcher; doing that here would mean an unauthenticated caller
// could drive the operator's Conversions API with a value of its choosing,
// bounded only by a token that lives in a URL. The ledger is the safe half,
// and it is the half a later attribution pass consumes (lb_inbound_events
// carries consumed_at for exactly that).
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureIntegrationsTables } from './trackingIntegrationsSchema.js';
import { CLICK_ID_NETWORK } from './trackingClicks.js';
import { listNetworks } from './trackingCustomNetworks.js';

// The event vocabulary an inbound caller may name. Anything else is ignored
// (the row is not written) — an unauthenticated party must not be able to mint
// arbitrary event names into the ledger.
export const INBOUND_EVENTS = [
  'Purchase', 'Lead', 'InitiateCheckout', 'AddPaymentInfo', 'AddToCart',
  'UpsellView', 'Refund',
];
const INBOUND_EVENT_SET = new Set(INBOUND_EVENTS);

// A payout above this is a malformed feed, not a sale. Bounded so one bad
// postback cannot poison a later revenue rollup with an astronomical number.
export const MAX_PAYOUT = 1_000_000;

export const TOKEN_BYTES = 16;          // 32 hex chars = 128 bits
export const TOKEN_LEN = TOKEN_BYTES * 2;
export const TOKEN_PREFIX_LEN = 8;

export const mintToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

// Constant-time token comparison.
//
// WHY NOT `WHERE token = $1`: the database's byte compare short-circuits on
// the first differing byte, and Postgres will also happily tell you, by
// timing, roughly how far your guess got. The lookup is therefore done on an
// indexed 8-char PREFIX (not a secret on its own — 32 bits of a 128-bit
// token) and the full value is compared in Node with timingSafeEqual.
//
// timingSafeEqual THROWS on a length mismatch, which would itself be an
// oracle, so the length is checked first against the fixed TOKEN_LEN and a
// wrong-length candidate never reaches the database at all.
export function tokensEqual(candidate, stored) {
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(String(stored || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export const isWellFormedToken = (t) => /^[0-9a-f]{32}$/.test(String(t || ''));

// Resolve a token to its endpoint row, or null. Returns null for a malformed
// token, an unknown token, and a DISABLED endpoint alike — the caller must not
// be able to tell those three apart.
export async function resolveToken(token) {
  const t = String(token || '');
  if (!isWellFormedToken(t)) return null;
  await ensureIntegrationsTables();
  const rows = await pgQuery(
    `SELECT id, funnel_id, purpose, label, token, enabled
     FROM lb_inbound_endpoints WHERE token_prefix = $1`,
    [t.slice(0, TOKEN_PREFIX_LEN)]
  );
  // Compare EVERY candidate (a prefix collision is possible, if unlikely) and
  // do not break early — the loop's cost must not depend on which row matched.
  let hit = null;
  for (const row of rows) {
    if (tokensEqual(t, row.token)) hit = row;
  }
  if (!hit || !hit.enabled) return null;
  return hit;
}

// ── payload normalisation ───────────────────────────────────────────────────
// Everything below takes an UNTRUSTED, arbitrarily-shaped params map and
// answers with bounded, typed values. Nothing throws.

const str = (v, max) => {
  if (v == null) return '';
  if (typeof v === 'object' || typeof v === 'function') return '';
  return String(v).slice(0, max);
};

// Flatten one request's query/body into a string map. Only scalars survive:
// a nested object or an array would otherwise land in the ledger as
// '[object Object]' or a comma-joined blob.
export function flattenParams(...sources) {
  const out = Object.create(null);
  for (const src of sources) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      const key = String(k).slice(0, 64).toLowerCase();
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue; // first source wins
      if (v == null) continue;
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') {
        out[key] = String(v).slice(0, 500);
      }
    }
    if (Object.keys(out).length > 100) break; // bounded — a 5k-key body is not a postback
  }
  return out;
}

const pick = (p, keys, max = 200) => {
  for (const k of keys) {
    const v = str(p[k], max);
    if (v) return v;
  }
  return '';
};

// The payout, bounded and NaN-safe. Returns null when there is nothing
// numeric to record — never 0, which is a legitimate value and must not be
// synthesised from a missing field.
export function parsePayout(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > MAX_PAYOUT) return null;
  return Math.round(n * 10000) / 10000;
}

// Find the click id the caller sent, and name its network. Order:
//   1. a KNOWN platform click-id param (fbclid, gclid, …) — CLICK_ID_NETWORK
//      is the single source of truth, same as the touch parser;
//   2. one of THIS funnel's custom-network click-id params;
//   3. the generic `click_id`, kept under a generic key so it is never
//      dropped (the reference lost attribution for built-in-network funnels
//      here — its review finding #9).
export function extractClick(params, customParams = []) {
  for (const [param, network] of CLICK_ID_NETWORK) {
    const v = str(params[param], 200);
    if (v) return { click_id: v, click_key: param, network };
  }
  for (const raw of customParams || []) {
    const param = String(raw || '').toLowerCase();
    if (!param) continue;
    const v = str(params[param], 200);
    if (v) return { click_id: v, click_key: param, network: `custom:${param}` };
  }
  const generic = str(params.click_id, 200);
  if (generic) return { click_id: generic, click_key: 'click_id', network: '' };
  return { click_id: '', click_key: '', network: '' };
}

// The deterministic ledger id. An order id makes it trivially stable; without
// one, a hash of the payload's identifying fields keeps an honest partner
// retry from double-counting. Either way the (endpoint_id, event_id) unique
// index is what actually enforces it.
export function deriveEventId({ event, orderId, click, payout, params }) {
  if (orderId) return `inb_${orderId}`.slice(0, 120);
  const basis = [
    event,
    click.click_key, click.click_id,
    payout == null ? '' : String(payout),
    str(params.email, 200).toLowerCase(),
    str(params.vid, 64),
  ].join('|');
  return `inb_${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

// Ingest ONE inbound postback. Returns a RESULT OBJECT for the admin ledger's
// benefit — the public route discards it and always answers the same body.
// Never throws: every failure mode returns a reason.
export async function ingest(endpoint, params, { ipHash = '' } = {}) {
  try {
    const p = (params && typeof params === 'object') ? params : Object.create(null);
    const event = str(p.event, 40) || 'Purchase';
    if (!INBOUND_EVENT_SET.has(event)) return { ok: false, reason: 'event_not_allowed' };

    await ensureIntegrationsTables();

    let customParams = [];
    try {
      const nets = await listNetworks(endpoint.funnel_id);
      customParams = nets.filter((n) => n.enabled && n.click_id_param).map((n) => n.click_id_param);
    } catch (err) {
      // A custom-network read failure must not drop a partner conversion —
      // the built-in click-id params still resolve.
      console.error('[inbound] custom param read failed (fail-open):', err.message);
    }

    const click = extractClick(p, customParams);
    const orderId = pick(p, ['order_id', 'transaction_id', 'txn_id'], 120);
    const payout = parsePayout(pick(p, ['payout', 'value', 'amount', 'revenue'], 40));

    // A conversion needs a stable identifier — an order id OR a click id — or
    // it is not a postback. This is what stops a link-preview fetch, a crawler
    // or an uptime monitor from writing a bogus Purchase into the ledger.
    if (!orderId && !click.click_id) return { ok: false, reason: 'no_conversion_data' };

    const currency = pick(p, ['currency', 'cur'], 8).toUpperCase();
    const eventId = deriveEventId({ event, orderId, click, payout, params: p });

    const rows = await pgQuery(
      `INSERT INTO lb_inbound_events
         (id, endpoint_id, funnel_id, event, event_id, click_id, click_key,
          network, order_id, payout, currency, raw, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (endpoint_id, event_id) DO NOTHING
       RETURNING id`,
      [`lbie_${crypto.randomBytes(9).toString('hex')}`, endpoint.id,
        String(endpoint.funnel_id || ''), event, eventId,
        click.click_id, click.click_key, click.network, orderId,
        payout, /^[A-Z]{3}$/.test(currency) ? currency : '',
        // RAW OBJECT into a jsonb param — postgres.js serialises it. Passing
        // JSON.stringify() here would store a jsonb STRING scalar and every
        // later jsonb operator on the column would throw.
        { ...p }, String(ipHash || '').slice(0, 64)]
    );

    // hits/last_hit_at count every ACCEPTED call, including a deduped replay:
    // "this endpoint is being called" is the operator's health signal, and a
    // silent duplicate is still traffic.
    await pgQuery(
      `UPDATE lb_inbound_endpoints SET hits = hits + 1, last_hit_at = NOW() WHERE id = $1`,
      [endpoint.id]
    );

    return rows.length
      ? { ok: true, event_id: eventId, id: rows[0].id }
      : { ok: true, event_id: eventId, deduped: true };
  } catch (err) {
    // Fail-open: the public route answers 200 whatever happens here.
    console.error('[inbound] ingest failed (fail-open):', err.message);
    return { ok: false, reason: 'error' };
  }
}

// ── endpoint CRUD (authed callers) ──────────────────────────────────────────
export const ENDPOINT_LIMIT = 10;

export async function listEndpoints(funnelId) {
  await ensureIntegrationsTables();
  return pgQuery(
    `SELECT id, funnel_id, purpose, label, token, enabled, hits, last_hit_at,
            created_at, updated_at
     FROM lb_inbound_endpoints WHERE funnel_id = $1 ORDER BY created_at ASC`,
    [String(funnelId)]
  );
}

export async function createEndpoint(funnelId, { purpose = '', label = '' } = {}) {
  await ensureIntegrationsTables();
  const token = mintToken();
  const rows = await pgQuery(
    `INSERT INTO lb_inbound_endpoints
       (id, funnel_id, purpose, label, token, token_prefix, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)
     RETURNING id, funnel_id, purpose, label, token, enabled, hits, last_hit_at,
               created_at, updated_at`,
    [`lbin_${crypto.randomBytes(9).toString('hex')}`, String(funnelId),
      String(purpose || '').slice(0, 40), String(label || '').slice(0, 60),
      token, token.slice(0, TOKEN_PREFIX_LEN)]
  );
  return rows[0];
}

export async function updateEndpoint(funnelId, id, fields) {
  await ensureIntegrationsTables();
  const sets = [];
  const params = [String(funnelId), String(id)];
  const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (fields.label !== undefined) put('label', String(fields.label || '').slice(0, 60));
  if (fields.purpose !== undefined) put('purpose', String(fields.purpose || '').slice(0, 40));
  if (fields.enabled !== undefined) put('enabled', fields.enabled);
  if (!sets.length) return null;
  const rows = await pgQuery(
    `UPDATE lb_inbound_endpoints SET ${sets.join(', ')}, updated_at = NOW()
     WHERE funnel_id = $1 AND id = $2
     RETURNING id, funnel_id, purpose, label, token, enabled, hits, last_hit_at,
               created_at, updated_at`,
    params
  );
  return rows.length ? rows[0] : null;
}

// Rotate the token in place — the revocation primitive. The old token stops
// resolving the instant this commits.
export async function rotateEndpointToken(funnelId, id) {
  await ensureIntegrationsTables();
  const token = mintToken();
  const rows = await pgQuery(
    `UPDATE lb_inbound_endpoints
     SET token = $3, token_prefix = $4, updated_at = NOW()
     WHERE funnel_id = $1 AND id = $2
     RETURNING id, funnel_id, purpose, label, token, enabled, hits, last_hit_at,
               created_at, updated_at`,
    [String(funnelId), String(id), token, token.slice(0, TOKEN_PREFIX_LEN)]
  );
  return rows.length ? rows[0] : null;
}

export async function deleteEndpoint(funnelId, id) {
  await ensureIntegrationsTables();
  const rows = await pgQuery(
    `DELETE FROM lb_inbound_endpoints WHERE funnel_id = $1 AND id = $2 RETURNING id`,
    [String(funnelId), String(id)]
  );
  return rows.length > 0;
}

export async function listEvents(funnelId, limit = 100) {
  await ensureIntegrationsTables();
  return pgQuery(
    `SELECT id, endpoint_id, event, event_id, click_id, click_key, network,
            order_id, payout, currency, raw, consumed_at, ts
     FROM lb_inbound_events WHERE funnel_id = $1 ORDER BY ts DESC LIMIT $2`,
    [String(funnelId), limit]
  );
}

export default {
  INBOUND_EVENTS, MAX_PAYOUT, TOKEN_LEN, mintToken, tokensEqual,
  isWellFormedToken, resolveToken, flattenParams, parsePayout, extractClick,
  deriveEventId, ingest, listEndpoints, createEndpoint, updateEndpoint,
  rotateEndpointToken, deleteEndpoint, listEvents, ENDPOINT_LIMIT,
};
