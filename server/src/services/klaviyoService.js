// Klaviyo integration — REST client + encrypted config store.
// Port of the funnel-os klaviyo_client posture into the house patterns:
//   • the API key lives ONLY in lb_integrations.config.api_key as a 'gcm1:'
//     AES-256-GCM ciphertext (encryptSecret/decryptSecret from
//     gatewayConfigs.js, CHECKOUT_CREDS_KEY) and is decrypted at call time,
//     straight into a request HEADER — never into argv, a URL, a log line,
//     or a stored/returned body slice.
//   • NEVER throws to callers — every failure returns { ok:false, error }
//     (fail-closed): a marketing hiccup must not touch checkout, settlement
//     or any page render.
//   • idempotency rides the Events API `unique_id` (Klaviyo dedups per
//     metric) — our own exactly-once claim layer is klaviyoEvents.js.
//   • 429s honor Retry-After with a SINGLE retry (the /accounts/ endpoint
//     throttles at burst 1/s — observed live, not theoretical).
//
// REVISION: verified empirically 2026-08-09 against the live API —
// '2026-07-15' answers 200 on /accounts/ (with negative controls: a future
// date 404s "Unable to specify a future revision date", a malformed one
// 400s), so it is the newest working revision, not a silent fallback.
import { pgQuery } from '../db/pg.js';
import { encryptSecret, decryptSecret } from './gatewayConfigs.js';
import { ensureIntegrationTables } from './integrationsSchema.js';

export const KLAVIYO_REVISION = '2026-07-15';
const KIND = 'klaviyo';

// Base override is for the test harness's mock server only.
function apiBase() {
  return process.env.KLAVIYO_API_BASE || 'https://a.klaviyo.com/api';
}
function timeoutMs() {
  const v = parseInt(process.env.KLAVIYO_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 15000;
}

const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// ── config store ────────────────────────────────────────────────────────────
// lb_integrations row kind='klaviyo', config JSONB:
//   { api_key: 'gcm1:…', enabled: bool, list_id_default: str,
//     last_test: { ok, account_name, error, at } }

async function loadRawConfig() {
  await ensureIntegrationTables();
  const rows = await pgQuery(`SELECT config FROM lb_integrations WHERE kind = $1`, [KIND]);
  return rows.length ? rows[0].config || {} : {};
}

// Decrypted view for API callers ONLY — never serialize this object.
export async function getKlaviyoConfig() {
  const cfg = await loadRawConfig();
  let apiKey = '';
  if (cfg.api_key) {
    try {
      apiKey = decryptSecret(cfg.api_key);
    } catch (err) {
      // Wrong/rotated CHECKOUT_CREDS_KEY: treat as unconfigured, loudly.
      console.error('[klaviyo] stored api_key failed to decrypt (rotated creds key?):', err.message);
    }
  }
  return {
    apiKey,
    enabled: Boolean(cfg.enabled),
    listIdDefault: s(cfg.list_id_default, 64),
  };
}

// Masked view — the ONLY shape routes may return. The key never appears.
export async function getKlaviyoPublicView() {
  const cfg = await loadRawConfig();
  return publicViewOf(cfg);
}

function publicViewOf(cfg) {
  return {
    api_key_set: Boolean(cfg.api_key),
    enabled: Boolean(cfg.enabled),
    list_id_default: s(cfg.list_id_default, 64),
    last_test: cfg.last_test && typeof cfg.last_test === 'object'
      ? {
          ok: Boolean(cfg.last_test.ok),
          account_name: s(cfg.last_test.account_name, 200),
          error: s(cfg.last_test.error, 200),
          at: s(cfg.last_test.at, 40),
        }
      : null,
  };
}

// Write-only patch, tracking-CRUD semantics for the secret:
//   api_key: '' or undefined → KEEP the stored key
//   api_key: null            → CLEAR it
//   api_key: 'pk_…'          → encrypt + replace
// enabled: boolean if present. list_id_default: undefined → keep, ''/null →
// clear, value → set. last_test is service-owned (writeLastTest), not
// patchable from a request body.
//
// CONCURRENCY (review fix HIGH#1, same remedy as the lb_pixels SQL-side
// merge): the previous read-merge-write with whole-object replace lost
// updates under concurrency (PUT‖PUT dropped the just-saved key 143/200 in
// the reviewer's probe; writeLastTest racing a Clear resurrected the cleared
// key 85/200). Now the DATABASE merges: each writer sends only its own patch
// keys + its own cleared keys and Postgres applies
//   config = (COALESCE(stored,'{}') - cleared::text[]) || patch::jsonb
// atomically per row — concurrent writers of DIFFERENT keys both land, and a
// writer can never resurrect a key it didn't touch.
export async function patchKlaviyoConfig(body = {}) {
  const patch = {};
  const cleared = [];
  if (body.api_key === null) {
    cleared.push('api_key', 'last_test'); // a test result for a removed key is a lie
  } else if (typeof body.api_key === 'string' && body.api_key.trim() !== '') {
    patch.api_key = encryptSecret(body.api_key.trim());
    cleared.push('last_test'); // stale for the new key until re-tested
  }
  if (body.enabled !== null && body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.list_id_default !== undefined) {
    const v = body.list_id_default === null ? '' : String(body.list_id_default).trim();
    if (v) patch.list_id_default = v.slice(0, 64);
    else cleared.push('list_id_default');
  }
  const cfg = await mergeConfig(patch, cleared);
  return publicViewOf(cfg);
}

// Pure jsonb patch of ONLY the last_test key — by construction it cannot
// resurrect (or drop) api_key/enabled/list_id_default, whatever it races.
export async function writeLastTest(result) {
  await mergeConfig({
    last_test: {
      ok: Boolean(result.ok),
      account_name: s(result.account_name, 200),
      error: s(result.error, 200),
      at: new Date().toISOString(),
    },
  }, []);
}

// The single write path: SQL-side merge, atomic per row.
// NB: pass `patch` as the RAW OBJECT — pgQuery (postgres.js) serializes jsonb
// params itself; pre-stringifying double-encodes into a jsonb STRING scalar
// and `- text[]` then throws 'cannot delete from scalar'.
async function mergeConfig(patch, cleared) {
  await ensureIntegrationTables();
  const rows = await pgQuery(
    `INSERT INTO lb_integrations (kind, config, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (kind) DO UPDATE SET
       config = (COALESCE(lb_integrations.config, '{}'::jsonb) - $3::text[]) || $2::jsonb,
       updated_at = NOW()
     RETURNING config`,
    [KIND, patch, cleared]
  );
  return rows[0]?.config || {};
}

// ── HTTP core ───────────────────────────────────────────────────────────────
// Never throws. Returns { ok, status, json, error }. The key rides ONLY the
// Authorization header; errors carry status/code strings, never body dumps.
async function klaviyoFetch(apiKey, method, path, body, { retried = false } = {}) {
  if (!apiKey) return { ok: false, status: null, json: null, error: 'not_configured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: KLAVIYO_REVISION,
        Accept: 'application/vnd.api+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* 202/204 bodies are empty */ }
    if (res.status === 429 && !retried) {
      const waitS = Math.min(Math.max(parseFloat(res.headers.get('retry-after')) || 1, 1), 10);
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      return klaviyoFetch(apiKey, method, path, body, { retried: true });
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, json, error: null };
    }
    const error = res.status === 401 || res.status === 403
      ? 'invalid_api_key'
      : `http_${res.status}`;
    return { ok: false, status: res.status, json, error };
  } catch (err) {
    return {
      ok: false, status: null, json: null,
      error: err.name === 'AbortError' ? 'timeout' : `network:${err.name}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveKey(opts = {}) {
  if (opts.apiKey) return opts.apiKey;
  const { apiKey } = await getKlaviyoConfig();
  return apiKey;
}

// ── API surface ─────────────────────────────────────────────────────────────

// Create-or-update a profile by email — the documented conflict flow:
// POST /profiles/ answers 201 (created, id in body) or 409 duplicate_profile
// (the existing id in errors[0].meta.duplicate_profile_id) → PATCH
// /profiles/{id}/ with the same attributes. Returns { ok, profileId }.
export async function upsertProfile({ email, first_name, last_name, phone, properties } = {}, opts = {}) {
  const apiKey = await resolveKey(opts);
  if (!apiKey) return { ok: false, error: 'not_configured' };
  if (!email) return { ok: false, error: 'no_identifier' };
  const attributes = { email: s(email, 254) };
  if (first_name) attributes.first_name = s(first_name, 100);
  if (last_name) attributes.last_name = s(last_name, 100);
  if (phone) attributes.phone_number = s(phone, 40);
  if (properties && typeof properties === 'object') attributes.properties = properties;

  const created = await klaviyoFetch(apiKey, 'POST', '/profiles/', {
    data: { type: 'profile', attributes },
  });
  if (created.ok) {
    return { ok: true, profileId: created.json?.data?.id || '', status: created.status };
  }
  if (created.status === 409) {
    const dupId = created.json?.errors?.[0]?.meta?.duplicate_profile_id || '';
    if (!dupId) return { ok: false, status: 409, error: 'conflict_without_duplicate_id' };
    const patched = await klaviyoFetch(apiKey, 'PATCH', `/profiles/${encodeURIComponent(dupId)}/`, {
      data: { type: 'profile', id: dupId, attributes },
    });
    if (patched.ok) return { ok: true, profileId: dupId, status: patched.status };
    return { ok: false, status: patched.status, error: patched.error };
  }
  return { ok: false, status: created.status, error: created.error };
}

// Fire one event. unique_id = OUR event id → Klaviyo-side idempotency per
// metric. 202 Accepted = success.
export async function trackEvent({ metric_name, email, phone, value, unique_id, properties, time } = {}, opts = {}) {
  const apiKey = await resolveKey(opts);
  if (!apiKey) return { ok: false, error: 'not_configured' };
  if (!metric_name) return { ok: false, error: 'no_metric' };
  if (!email && !phone) return { ok: false, error: 'no_identifier' };
  const profile = {};
  if (email) profile.email = s(email, 254);
  if (phone) profile.phone_number = s(phone, 40);
  const attributes = {
    metric: { data: { type: 'metric', attributes: { name: s(metric_name, 128) } } },
    profile: { data: { type: 'profile', attributes: profile } },
    properties: properties && typeof properties === 'object' ? properties : {},
  };
  if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
    attributes.value = Math.round(Number(value) * 100) / 100;
  }
  if (unique_id) attributes.unique_id = s(String(unique_id), 128);
  if (time) attributes.time = s(String(time), 40);
  const res = await klaviyoFetch(apiKey, 'POST', '/events/', {
    data: { type: 'event', attributes },
  });
  return { ok: res.ok, status: res.status, error: res.error };
}

// Consent-correct subscribe: the bulk-create job is the ONLY server path that
// can SET marketing consent (profile upsert cannot). 202 Accepted = queued.
export async function subscribeToList({ listId, email } = {}, opts = {}) {
  const apiKey = await resolveKey(opts);
  if (!apiKey) return { ok: false, error: 'not_configured' };
  if (!listId) return { ok: false, error: 'no_list' };
  if (!email) return { ok: false, error: 'no_identifier' };
  const res = await klaviyoFetch(apiKey, 'POST', '/profile-subscription-bulk-create-jobs/', {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: 'Puure CRM',
        profiles: {
          data: [{
            type: 'profile',
            attributes: {
              email: s(email, 254),
              subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
            },
          }],
        },
      },
      relationships: { list: { data: { type: 'list', id: s(String(listId), 64) } } },
    },
  });
  return { ok: res.ok, status: res.status, error: res.error };
}

// Account identity — the "Test connection" round-trip.
export async function getAccount(opts = {}) {
  const apiKey = await resolveKey(opts);
  if (!apiKey) return { ok: false, error: 'not_configured' };
  const res = await klaviyoFetch(apiKey, 'GET', '/accounts/');
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const a0 = Array.isArray(res.json?.data) ? res.json.data[0] : null;
  const contact = a0?.attributes?.contact_information || {};
  return {
    ok: true,
    status: res.status,
    account: {
      id: s(a0?.id || '', 64),
      name: s(contact.organization_name || '', 200),
      sender_email: s(contact.default_sender_email || '', 254),
      sender_name: s(contact.default_sender_name || '', 200),
      test_account: Boolean(a0?.attributes?.test_account),
    },
  };
}

// Lists for the default-list picker. Follows pagination up to 5 pages.
export async function getLists(opts = {}) {
  const apiKey = await resolveKey(opts);
  if (!apiKey) return { ok: false, error: 'not_configured' };
  const lists = [];
  let path = '/lists/';
  for (let page = 0; page < 5 && path; page++) {
    const res = await klaviyoFetch(apiKey, 'GET', path);
    if (!res.ok) return { ok: false, status: res.status, error: res.error };
    for (const row of res.json?.data || []) {
      lists.push({ id: s(row.id, 64), name: s(row.attributes?.name || '', 200) });
    }
    const next = res.json?.links?.next || '';
    // The next link is absolute — keep only its path+query, same host only.
    path = '';
    if (next) {
      try {
        const u = new URL(next);
        path = u.pathname.replace(/^\/api/, '') + u.search;
      } catch { /* malformed next link: stop paging */ }
    }
  }
  if (path) console.warn('[klaviyo] lists pagination cap (5 pages) hit — picker list is truncated');
  return { ok: true, lists };
}
