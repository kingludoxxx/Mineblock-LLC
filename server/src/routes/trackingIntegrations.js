// Tracking INTEGRATIONS — the authed write surface for the two halves of the
// ad-network integrations layer:
//
//   A. CUSTOM S2S NETWORKS   operator-defined OUTBOUND postback templates
//      GET    /:funnelId/custom-networks
//      POST   /:funnelId/custom-networks
//      GET    /:funnelId/custom-networks/:id
//      PUT    /:funnelId/custom-networks/:id
//      DELETE /:funnelId/custom-networks/:id
//      POST   /:funnelId/custom-networks/:id/test        ← synthetic test fire
//      POST   /:funnelId/custom-networks/preset/:key     ← create from a preset
//
//   B. INBOUND POSTBACKS     tokenized endpoints networks call back INTO us
//      GET    /:funnelId/inbound-endpoints
//      POST   /:funnelId/inbound-endpoints
//      PUT    /:funnelId/inbound-endpoints/:id
//      POST   /:funnelId/inbound-endpoints/:id/rotate
//      DELETE /:funnelId/inbound-endpoints/:id
//      GET    /:funnelId/inbound-events
//
//   plus  GET /:funnelId/directory — the card-grid metadata + ad-URL macros.
//
// A NEW FILE ON PURPOSE. routes/trackingAdmin.js owns the named-network
// registry CRUD and is another lane's file; this router mounts on the SAME
// base path (/api/v1/tracking-admin) and none of its paths collide with that
// router's, so both are served without either being edited.
//
// Mount (routes/index.js, ALONGSIDE trackingAdminRoutes):
//   app.use('/api/v1/tracking-admin', trackingIntegrationsRoutes);
//
// Auth: the same chain every funnel-settings surface uses —
// authenticate + requirePermission('funnels', 'access').
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureIntegrationsTables } from '../services/trackingIntegrationsSchema.js';
import {
  CUSTOM_EVENT_NAMES, validateNetworkBody, networkView, listNetworks,
  getNetwork, createNetwork, updateNetwork, deleteNetwork, asPixel,
  readEventNames, slugOf,
} from '../services/trackingCustomNetworks.js';
import { testFireCustomNetwork } from '../services/trackingDelivery.js';
import { MACRO_NAMES } from '../services/trackingPostbackTemplate.js';
import {
  INBOUND_EVENTS, listEndpoints, createEndpoint, updateEndpoint,
  rotateEndpointToken, deleteEndpoint, listEvents, ENDPOINT_LIMIT,
} from '../services/trackingInbound.js';
import {
  NETWORK_DIRECTORY, FOUNDATION, SUB_CONVENTION, presetBodyFor, networkByKey,
} from '../services/trackingNetworkDirectory.js';

const router = Router();
const authed = [authenticate, requirePermission('funnels', 'access')];

// Funnel id handling — NO TRUNCATION (the same rule funnelTrackingExtras
// applies): a silently shortened id is a DIFFERENT id that matches no row and
// can never line up with a delivery breaker scope. Refuse loudly instead.
const MAX_FUNNEL_ID = 128;
const funnelIdOf = (req) => {
  const raw = String(req.params.funnelId ?? '');
  return raw && raw.length <= MAX_FUNNEL_ID ? raw : null;
};
const rowIdOf = (req) => {
  const raw = String(req.params.id ?? '');
  return raw && raw.length <= 64 ? raw : null;
};

const bad = (res, code, status = 400) => res.status(status).json({ success: false, error: { code } });
// How many events a row is toggled on for — read through the both-shape jsonb
// parser, never off the raw column.
const readEventNamesLen = (row) => readEventNames(row.event_names).length;
const oops = (res, where, err) => {
  console.error(`[trackingIntegrations] ${where} failed:`, err.message);
  return res.status(500).json({ success: false, error: { code: 'internal_error' } });
};

// Resolve + prove the funnel EXISTS before any write. Without it a typo'd id
// happily inserts orphan rows that nothing ever collects.
async function resolveFunnel(req, res) {
  const funnelId = funnelIdOf(req);
  if (!funnelId) { bad(res, 'invalid_funnel_id'); return null; }
  const rows = await pgQuery(`SELECT id, slug, custom_domain FROM funnels WHERE id = $1 LIMIT 1`, [funnelId]);
  if (!rows.length) { bad(res, 'funnel_not_found', 404); return null; }
  req.funnelRow = rows[0];
  return funnelId;
}

// ── GET /:funnelId/directory ────────────────────────────────────────────────
// The card grid's metadata + the per-network ad-URL macros, served from the
// server-side directory so the client never carries a second copy of the
// macro sets. Read-only; no database work beyond the funnel existence check.
router.get('/:funnelId/directory', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const f = req.funnelRow || {};
    // The funnel's public serving base — custom domain wins, else /f/<slug>.
    // PUBLIC_BASE_URL is the app origin; when it is unset the client falls
    // back to its own window.location.origin (it says so in the response).
    const origin = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const base = f.custom_domain
      ? `https://${f.custom_domain}`
      : (origin ? `${origin}/f/${f.slug || ''}` : '');
    return res.json({
      success: true,
      data: {
        networks: NETWORK_DIRECTORY.map((n) => ({
          key: n.key,
          kind: n.kind || null,
          name: n.name,
          method: n.method,
          tag: n.tag,
          accent: n.accent,
          click_ids: n.click_ids,
          wired: n.wired,
          id_label: n.id_label,
          setup: n.setup,
          click_id_note: n.click_id_note || '',
          ad_url_params: n.ad_url_params || '',
          has_preset: Boolean(n.preset),
          // The lb_custom_networks.key a preset created from this card lands
          // under — computed from the preset LABEL by the same slugger the
          // create path uses, so the client matches on a value the server
          // derived rather than re-deriving the slug rule in JSX.
          preset_network_key: n.preset ? slugOf(n.preset.label) : '',
          preset_needs_credential: Boolean(n.preset && n.preset.needs_credential),
          preset_credential_note: (n.preset && n.preset.credential_note) || '',
        })),
        foundation: FOUNDATION,
        sub_convention: SUB_CONVENTION,
        // '' when PUBLIC_BASE_URL is unset AND no custom domain — the client
        // then builds the base from its own origin. Never guess server-side.
        serving_base: base,
        serving_base_source: f.custom_domain ? 'custom_domain' : (origin ? 'public_base_url' : 'client_origin'),
        macros: MACRO_NAMES,
        custom_events: CUSTOM_EVENT_NAMES,
        inbound_events: INBOUND_EVENTS,
      },
    });
  } catch (err) {
    return oops(res, 'directory', err);
  }
});

// ── A. CUSTOM S2S NETWORKS ──────────────────────────────────────────────────

router.get('/:funnelId/custom-networks', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const rows = await listNetworks(funnelId);
    return res.json({ success: true, data: { networks: rows.map(networkView) } });
  } catch (err) {
    return oops(res, 'custom-networks list', err);
  }
});

// GET /:funnelId/custom-networks/health — the same three counters the named
// networks get in trackingAdmin's /tracking/summary, but keyed by custom
// network. That summary iterates the NAMED registry, so a custom network is
// invisible in it; without this a preset card could only ever show blanks.
//
// The counters read lb_tracking_events where platform = 'custom' — which is
// exactly what trackingCustomNetworks.asPixel makes the delivery layer write
// (kind 'custom', pixel_id = the network key). queued_now is the LIVE queue
// depth, not a ledger count, so a drained retry stops reading as queued.
//
// NB this route is declared BEFORE '/:funnelId/custom-networks/:id' on
// purpose: Express matches in declaration order and 'health' would otherwise
// be captured as an :id and 404.
router.get('/:funnelId/custom-networks/health', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    await ensureIntegrationsTables();
    const [counts, queued, breakers, nets] = await Promise.all([
      pgQuery(
        `SELECT pixel_id AS key,
                COUNT(*) FILTER (WHERE status = 'sent')::int    AS sent_24h,
                COUNT(*) FILTER (WHERE status IN ('skipped','error'))::int AS failed_24h,
                COUNT(*) FILTER (WHERE status = 'deduped')::int AS deduped_24h
         FROM lb_tracking_events
         WHERE funnel_id = $1 AND platform = 'custom' AND ts > NOW() - INTERVAL '24 hours'
         GROUP BY pixel_id`,
        [funnelId]
      ),
      pgQuery(
        `SELECT pixel_row_id, COUNT(*)::int AS n FROM lb_postback_queue
         WHERE funnel_id = $1 AND status IN ('queued','sending') GROUP BY pixel_row_id`,
        [funnelId]
      ),
      pgQuery(
        `SELECT scope_id, fails, open_until FROM lb_postback_breakers WHERE funnel_id = $1`,
        [funnelId]
      ),
      listNetworks(funnelId),
    ]);
    const byKey = new Map(counts.map((c) => [c.key, c]));
    const queuedByRow = new Map(queued.map((q) => [q.pixel_row_id, q.n]));
    const now = Date.now();
    return res.json({
      success: true,
      data: {
        health: nets.map((n) => {
          const c = byKey.get(n.key) || {};
          // The breaker scope is `${funnelId}:${rowId}` (trackingDelivery).
          const b = breakers.find((x) => x.scope_id === `${funnelId}:${n.id}`);
          const open = Boolean(b && b.open_until && new Date(b.open_until).getTime() > now);
          return {
            id: n.id,
            key: n.key,
            sent_24h: c.sent_24h || 0,
            failed_24h: c.failed_24h || 0,
            deduped_24h: c.deduped_24h || 0,
            queued_now: queuedByRow.get(n.id) || 0,
            breaker: { state: open ? 'open' : 'closed', fails: b ? b.fails : 0, open_until: b ? b.open_until : null },
            // A postback template needs no credential to be "ready" — the
            // click id IS the credential. Ready = enabled AND at least one
            // event toggled on, which is the whole of what can be checked
            // without firing.
            server_channel_ready: Boolean(n.enabled && readEventNamesLen(n)),
          };
        }),
      },
    });
  } catch (err) {
    return oops(res, 'custom-network health', err);
  }
});

router.get('/:funnelId/custom-networks/:id', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const row = await getNetwork(funnelId, id);
    if (!row) return bad(res, 'not_found', 404);
    return res.json({ success: true, data: { network: networkView(row) } });
  } catch (err) {
    return oops(res, 'custom-network read', err);
  }
});

// POST — create. The template is validated for SHAPE here
// (validateNetworkBody → validateTemplateShape: https/http, no userinfo, and
// NO MACRO ANYWHERE IN THE AUTHORITY) and for REACHABILITY below.
router.post('/:funnelId/custom-networks', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const check = validateNetworkBody(req.body, { isCreate: true });
    if (!check.ok) return bad(res, check.code);
    const guard = await guardTemplateHost(check.fields.url_template);
    if (guard.refuse) return bad(res, guard.code);
    await ensureIntegrationsTables();
    const existing = await listNetworks(funnelId);
    if (existing.length >= 25) return bad(res, 'network_limit', 422);
    const row = await createNetwork(funnelId, check.fields);
    if (!row) return bad(res, 'duplicate_label', 409);
    return res.status(201).json({
      success: true,
      data: { network: networkView(row), warning: guard.warning || null },
    });
  } catch (err) {
    return oops(res, 'custom-network create', err);
  }
});

// POST /preset/:key — create a custom network prefilled from a directory
// preset (Taboola / Outbrain / NewsBreak / RevContent / MGID). Identical
// validation to a hand-typed create: a preset is a convenience, never a
// bypass. Presets that still carry a credential placeholder land DISABLED.
router.post('/:funnelId/custom-networks/preset/:key', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const body = presetBodyFor(req.params.key);
    if (!body) return bad(res, 'unknown_preset', 404);
    const check = validateNetworkBody(body, { isCreate: true });
    if (!check.ok) return bad(res, check.code);
    const guard = await guardTemplateHost(check.fields.url_template);
    if (guard.refuse) return bad(res, guard.code);
    await ensureIntegrationsTables();
    const row = await createNetwork(funnelId, check.fields);
    if (!row) return bad(res, 'duplicate_label', 409);
    const net = networkByKey(req.params.key);
    return res.status(201).json({
      success: true,
      data: {
        network: networkView(row),
        credential_note: (net && net.preset && net.preset.credential_note) || '',
        warning: guard.warning || null,
      },
    });
  } catch (err) {
    return oops(res, 'custom-network preset create', err);
  }
});

router.put('/:funnelId/custom-networks/:id', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const check = validateNetworkBody(req.body, { isCreate: false });
    if (!check.ok) return bad(res, check.code);
    let warning = null;
    if (check.fields.url_template !== undefined) {
      const guard = await guardTemplateHost(check.fields.url_template);
      if (guard.refuse) return bad(res, guard.code);
      warning = guard.warning || null;
    }
    const row = await updateNetwork(funnelId, id, check.fields);
    if (!row) return bad(res, 'not_found', 404);
    return res.json({ success: true, data: { network: networkView(row), warning } });
  } catch (err) {
    // A rename can collide with an existing (funnel_id, key).
    if (String(err.message || '').includes('uq_lb_custom_networks_funnel_key')) {
      return bad(res, 'duplicate_label', 409);
    }
    return oops(res, 'custom-network update', err);
  }
});

router.delete('/:funnelId/custom-networks/:id', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const gone = await deleteNetwork(funnelId, id);
    if (!gone) return bad(res, 'not_found', 404);
    // Queued rows for this network stay in lb_postback_queue and will settle
    // as 'pixel_gone' on the next drain — a correct, visible dead-letter
    // rather than a silent disappearance.
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return oops(res, 'custom-network delete', err);
  }
});

// POST /:id/test — SYNTHETIC TEST FIRE.
//
// Renders the template against an obviously-fake context (click id
// TEST_CLICK_ID, $1.00, order id test_<hex>) and fires it, then returns the
// RESOLVED URL and the response code.
//
// The rendered url is returned VERBATIM and nothing about it is masked — it is
// the operator's own text, and hiding half of it is precisely what makes a
// broken template impossible to debug. What it must NOT do is travel anywhere
// else: this response is the only place it appears, no ledger row is written,
// and nothing is logged.
router.post('/:funnelId/custom-networks/:id/test', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const row = await getNetwork(funnelId, id);
    if (!row) return bad(res, 'not_found', 404);

    // The test event name is operator-chosen so a network toggled on for Lead
    // only can still be proven. It is validated against the same vocabulary.
    const wanted = req.body && req.body.event ? String(req.body.event) : 'Purchase';
    if (!CUSTOM_EVENT_NAMES.includes(wanted)) return bad(res, 'unknown_event_name');

    const testId = `test_${Math.random().toString(16).slice(2, 12)}`;
    const envelope = {
      event_name: wanted,
      event_id: testId,
      user_data: { click_id: 'TEST_CLICK_ID' },
      custom_data: {
        value: 1, currency: 'USD', order_id: testId,
        subs: { sub1: 'testsub1', sub2: 'testsub2' },
      },
      event_source_url: 'https://example.com/puure-test',
      idk: ['test'],
    };
    const result = await testFireCustomNetwork(asPixel(row), envelope);
    return res.json({
      success: true,
      data: {
        ok: Boolean(result.ok),
        rendered_url: result.rendered_url || '',
        method: result.method || row.method || 'GET',
        status: Number.isInteger(result.status) ? result.status : null,
        // `raw` is the first 200 chars of whatever answered.
        response: result.body || null,
        error: result.error || '',
        event: wanted,
        note: 'Synthetic fire — no ledger row was written and no delivery claim was taken. A 2xx proves the endpoint ACCEPTED the request, not that the network recorded a conversion.',
      },
    });
  } catch (err) {
    return oops(res, 'custom-network test', err);
  }
});

// ── B. INBOUND POSTBACK ENDPOINTS ───────────────────────────────────────────

// The public URL an operator pastes into a network's postback field. Built
// from PUBLIC_BASE_URL when set; otherwise the path only, and the client
// prefixes its own origin (never guess an origin server-side — a wrong one
// silently sends every partner conversion to a host we do not own).
function inboundUrl(token) {
  const origin = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return { path: `/pb/${token}`, url: origin ? `${origin}/pb/${token}` : '' };
}

const endpointView = (row) => ({
  id: row.id,
  funnel_id: row.funnel_id,
  purpose: row.purpose || '',
  label: row.label || '',
  // The token IS the URL — an operator who cannot read it cannot configure the
  // network. It is a capability, revocable by rotate/delete, scoped to writing
  // rows in one ledger table for one funnel.
  token: row.token,
  ...inboundUrl(row.token),
  enabled: Boolean(row.enabled),
  hits: Number(row.hits || 0),
  last_hit_at: row.last_hit_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

router.get('/:funnelId/inbound-endpoints', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const rows = await listEndpoints(funnelId);
    return res.json({
      success: true,
      data: { endpoints: rows.map(endpointView), allowed_events: INBOUND_EVENTS },
    });
  } catch (err) {
    return oops(res, 'inbound list', err);
  }
});

router.post('/:funnelId/inbound-endpoints', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const existing = await listEndpoints(funnelId);
    if (existing.length >= ENDPOINT_LIMIT) return bad(res, 'endpoint_limit', 422);
    const row = await createEndpoint(funnelId, {
      purpose: b.purpose, label: b.label || 'Incoming postbacks',
    });
    return res.status(201).json({ success: true, data: { endpoint: endpointView(row) } });
  } catch (err) {
    return oops(res, 'inbound create', err);
  }
});

router.put('/:funnelId/inbound-endpoints/:id', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (b.enabled !== undefined && b.enabled !== true && b.enabled !== false) {
      return bad(res, 'invalid_enabled');
    }
    const fields = {};
    if (b.label !== undefined) fields.label = b.label;
    if (b.purpose !== undefined) fields.purpose = b.purpose;
    if (b.enabled !== undefined) fields.enabled = b.enabled;
    if (!Object.keys(fields).length) return bad(res, 'nothing_to_update');
    const row = await updateEndpoint(funnelId, id, fields);
    if (!row) return bad(res, 'not_found', 404);
    return res.json({ success: true, data: { endpoint: endpointView(row) } });
  } catch (err) {
    return oops(res, 'inbound update', err);
  }
});

// Rotate = revoke. The old token stops resolving the instant this commits;
// anything still posting to it gets the same silent 200 every unknown token
// gets, so a stale integration fails QUIETLY and shows up as a flat hit count.
router.post('/:funnelId/inbound-endpoints/:id/rotate', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const row = await rotateEndpointToken(funnelId, id);
    if (!row) return bad(res, 'not_found', 404);
    return res.json({ success: true, data: { endpoint: endpointView(row) } });
  } catch (err) {
    return oops(res, 'inbound rotate', err);
  }
});

router.delete('/:funnelId/inbound-endpoints/:id', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const id = rowIdOf(req);
    if (!id) return bad(res, 'invalid_id');
    const gone = await deleteEndpoint(funnelId, id);
    if (!gone) return bad(res, 'not_found', 404);
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return oops(res, 'inbound delete', err);
  }
});

// The ingest ledger — the ONLY place an operator can see what a token actually
// received. The public endpoint tells the caller nothing (anti-probing), so
// this is where an integration is verified.
router.get('/:funnelId/inbound-events', authed, async (req, res) => {
  try {
    const funnelId = await resolveFunnel(req, res);
    if (!funnelId) return undefined;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
    const rows = await listEvents(funnelId, limit);
    return res.json({ success: true, data: { events: rows } });
  } catch (err) {
    return oops(res, 'inbound events', err);
  }
});

// ── the save-time SSRF gate ─────────────────────────────────────────────────
// The shape check (no macro in the authority) already ran in
// validateNetworkBody. This is the second half: resolve the host and refuse a
// private / loopback / link-local answer.
//
// DECISION — a DNS FAILURE IS A WARNING AT SAVE TIME, NOT A REFUSAL. The
// fire-time guard fails CLOSED on the identical check, so an unresolvable host
// can never actually be contacted; refusing the save as well would only mean a
// transient resolver wobble blocks an operator from editing a template. The
// definitive verdicts ('scheme', 'blocked_host') DO refuse, because those
// cannot become safe later.
//
// The import is deferred to call time to keep this router's module graph free
// of the delivery layer's boot-time side effects.
async function guardTemplateHost(template) {
  const { endpointAllowed } = await import('../services/trackingDelivery.js');
  const verdict = await endpointAllowed(String(template || ''));
  if (verdict === true) return { refuse: false };
  if (verdict === 'dns_resolution_failed') {
    return {
      refuse: false,
      warning: 'The host in this template did not resolve just now. It is saved, but nothing will be delivered to it until it does — the delivery layer re-checks on every fire and refuses an unresolvable host.',
    };
  }
  return { refuse: true, code: `unsafe_template_${verdict}` };
}

export default router;
