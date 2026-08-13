import api from './api';

/**
 * Drop-in replacement for `fetch()` for SAME-ORIGIN calls to /api/v1.
 *
 * Why this exists: every feature in the dashboard talks to the API through the
 * shared axios instance, which AuthContext decorates with two interceptors —
 * one that attaches `Authorization: Bearer <accessToken>` and one that, on a
 * 401, refreshes the token once and replays the request. Brand Spy was the one
 * feature calling `fetch()` directly, so it had neither. It worked only for as
 * long as the login cookie lived (Max-Age=900 — 15 minutes), and once that
 * lapsed every Brand Spy call 401'd with nothing to recover it, while the rest
 * of the app kept working. Routing through `api` means there is exactly ONE
 * authentication path in the client and Brand Spy cannot drift from it again.
 *
 * Returns a Response-like object so existing `res.ok` / `res.status` /
 * `res.json()` call sites keep working unchanged.
 *
 * Use plain `fetch()` for cross-origin media (fbcdn/R2 video + image blobs) —
 * those must not carry our Authorization header.
 */

function toResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data ?? '')),
  };
}

export default async function authFetch(url, init = {}) {
  const method = (init.method || 'GET').toUpperCase();

  // Call sites hand us absolute '/api/v1/...' paths; the axios instance already
  // has '/api/v1' as its baseURL, so strip it to avoid doubling the prefix.
  const path = String(url).replace(/^\/api\/v1/, '');

  let data = init.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* not JSON — pass through as-is */ }
  }

  try {
    const res = await api.request({ url: path, method, data, headers: init.headers, signal: init.signal });
    return toResponse(res.status, res.data);
  } catch (err) {
    // Let axios reject on non-2xx (that is what triggers the 401 refresh-and-
    // retry interceptor), then convert the settled result back into fetch's
    // semantics, where an HTTP error still resolves.
    if (err.response) return toResponse(err.response.status, err.response.data);
    throw err; // genuine network/abort failure — matches fetch()
  }
}
