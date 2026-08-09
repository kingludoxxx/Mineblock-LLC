// Domain Hub — optional Cloudflare DNS automation ("AI auto-connect" leg).
// When CLOUDFLARE_API_TOKEN is configured AND the domain's zone lives in the
// operator's Cloudflare account, the required records are created via API
// instead of pasted by hand. Entirely optional: absent creds → the attach
// flow returns manual instructions and everything still works.
//
// Env: CLOUDFLARE_API_TOKEN (never in URLs — Authorization header only),
// CLOUDFLARE_API_BASE as the test seam.
import { registrableDomain, requiredRecords } from './dnsInspect.js';

function apiBase() {
  return String(process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
}
function apiToken() {
  return String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
}
export function cloudflareConfigured() {
  return Boolean(apiToken());
}

async function cfCall(method, path, body) {
  if (!cloudflareConfigured()) return { ok: false, error: 'cloudflare_not_configured' };
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiToken()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: `cloudflare_unreachable: ${err.message}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || json?.success === false) {
    const msg = json?.errors?.[0]?.message || `http_${res.status}`;
    return { ok: false, error: msg, json };
  }
  return { ok: true, json };
}

/** Zone id for the domain's registrable zone in this CF account, or null. */
export async function findZone(ascii) {
  const zone = registrableDomain(ascii);
  const res = await cfCall('GET', `/zones?name=${encodeURIComponent(zone)}&status=active`);
  if (!res.ok) return { ok: false, error: res.error };
  const z = (res.json?.result || [])[0];
  if (!z) return { ok: true, zone: null };
  return { ok: true, zone: { id: z.id, name: z.name } };
}

/**
 * Create the required records for `ascii` in its Cloudflare zone.
 * Idempotent: an existing record with the same type+name is updated, not
 * duplicated. proxied:false — Render must see the CNAME/A directly to verify
 * and issue TLS (an orange-cloud proxy hides the target).
 * Returns { ok, created:[…], error? } — per-record results, fail-open.
 */
export async function autoCreateRecords(ascii) {
  const found = await findZone(ascii);
  if (!found.ok) return { ok: false, error: found.error, created: [] };
  if (!found.zone) return { ok: false, error: 'zone_not_in_cloudflare_account', created: [] };
  const zoneId = found.zone.id;

  const wanted = requiredRecords(ascii).map((r) => ({
    type: r.type,
    name: r.host, // CF accepts FQDN names
    content: r.value,
    ttl: 1, // auto
    proxied: false,
  }));

  const results = [];
  for (const rec of wanted) {
    // Look for an existing record of this type+name first (idempotency).
    const list = await cfCall(
      'GET',
      `/zones/${zoneId}/dns_records?type=${encodeURIComponent(rec.type)}&name=${encodeURIComponent(rec.name)}`
    );
    const existing = list.ok ? (list.json?.result || [])[0] : null;
    let res;
    if (existing) {
      if (existing.content === rec.content && existing.proxied === false) {
        results.push({ ...rec, action: 'exists', ok: true });
        continue;
      }
      res = await cfCall('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, rec);
      results.push({ ...rec, action: 'updated', ok: res.ok, error: res.ok ? undefined : res.error });
    } else {
      res = await cfCall('POST', `/zones/${zoneId}/dns_records`, rec);
      results.push({ ...rec, action: 'created', ok: res.ok, error: res.ok ? undefined : res.error });
    }
  }
  const allOk = results.every((r) => r.ok);
  return { ok: allOk, created: results, error: allOk ? undefined : 'some_records_failed' };
}
