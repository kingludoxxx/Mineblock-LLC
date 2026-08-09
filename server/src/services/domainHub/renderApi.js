// Domain Hub — Render custom-domains API client.
//
//   POST   /v1/services/{serviceId}/custom-domains          — register a host
//   GET    /v1/services/{serviceId}/custom-domains          — list
//   GET    /v1/services/{serviceId}/custom-domains/{id}     — one
//   DELETE /v1/services/{serviceId}/custom-domains/{id}     — remove
//   POST   /v1/services/{serviceId}/custom-domains/{id}/verify — re-verify
//
// Once DNS points at the service, Render issues TLS for the domain — that
// issuance is asynchronous (minutes), so `connected` here means "registered
// and DNS-verified"; certificate readiness lags slightly behind.
//
// Env: RENDER_API_KEY + RENDER_SERVICE_ID (never hardcoded), and
// RENDER_API_BASE as the test seam (default https://api.render.com).
// The key travels ONLY in the Authorization header — never in a URL.

function apiBase() {
  return String(process.env.RENDER_API_BASE || 'https://api.render.com').replace(/\/$/, '');
}
function apiKey() {
  return String(process.env.RENDER_API_KEY || '').trim();
}
function serviceId() {
  return String(process.env.RENDER_SERVICE_ID || '').trim();
}

export function renderConfigured() {
  return Boolean(apiKey() && serviceId());
}

async function call(method, path, body) {
  if (!renderConfigured()) {
    return { ok: false, status: 0, error: 'render_not_configured' };
  }
  const url = `${apiBase()}/v1/services/${encodeURIComponent(serviceId())}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, status: 0, error: `render_unreachable: ${err.message}` };
  }
  let json = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || `http_${res.status}`;
    return { ok: false, status: res.status, error: msg, json };
  }
  return { ok: true, status: res.status, json };
}

// Render list endpoints may wrap items as [{customDomain:{…}, cursor}] or
// return the objects flat — tolerate both.
function unwrapList(json) {
  if (!Array.isArray(json)) return [];
  return json.map((x) => x?.customDomain || x).filter((x) => x && x.name);
}

/** All custom domains currently on the service. */
export async function listCustomDomains() {
  const res = await call('GET', '/custom-domains?limit=100');
  if (!res.ok) return res;
  return { ok: true, domains: unwrapList(res.json) };
}

/**
 * Idempotently register `domain` on the service: LIST FIRST — if Render
 * already has the host (this run or a previous one), return the existing
 * object instead of creating a duplicate. A 409 from create is also treated
 * as "already there" and resolved via a fresh list.
 */
export async function ensureCustomDomain(domain) {
  const existing = await listCustomDomains();
  if (!existing.ok) return existing;
  const hit = existing.domains.find(
    (d) => String(d.name).toLowerCase() === domain
  );
  if (hit) return { ok: true, created: false, domain: hit };

  const res = await call('POST', '/custom-domains', { name: domain });
  if (res.ok) {
    const obj = res.json?.customDomain || (Array.isArray(res.json) ? unwrapList(res.json)[0] : res.json);
    return { ok: true, created: true, domain: obj || { name: domain } };
  }
  if (res.status === 409) {
    const again = await listCustomDomains();
    const dup = again.ok ? again.domains.find((d) => String(d.name).toLowerCase() === domain) : null;
    if (dup) return { ok: true, created: false, domain: dup };
  }
  return res;
}

/** One custom domain by Render id or name. */
export async function getCustomDomain(idOrName) {
  const res = await call('GET', `/custom-domains/${encodeURIComponent(idOrName)}`);
  if (!res.ok) return res;
  return { ok: true, domain: res.json?.customDomain || res.json };
}

/** Ask Render to re-run DNS verification for the domain. Optional — some API
 *  versions verify automatically; a 404/405 here is non-fatal to the flow. */
export async function verifyCustomDomain(idOrName) {
  const res = await call('POST', `/custom-domains/${encodeURIComponent(idOrName)}/verify`);
  return res;
}

/** Remove the registration. A 404 counts as success (already gone) so detach
 *  stays idempotent. */
export async function deleteCustomDomain(idOrName) {
  const res = await call('DELETE', `/custom-domains/${encodeURIComponent(idOrName)}`);
  if (res.ok || res.status === 404) return { ok: true, gone: true };
  return res;
}
