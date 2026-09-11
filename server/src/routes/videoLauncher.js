// VIDEO LAUNCHER — the server side of the ClickUp Pipeline page (W9, R20).
//
// ── THE DEFECT THIS ROUTE EXISTS TO CLOSE ──────────────────────────────────
// On hub/main 3a10be7, client/src/pages/production/ClickupPipeline.jsx:4-8 read:
//
//   const PIPELINE_URL       = 'https://<a per-store launcher host>';
//   const PIPELINE_EMBED_URL = `${PIPELINE_URL}/?access=<an admin token>`;
//
// Both were compiled into client/dist/assets/index-*.js — the PUBLIC bundle of
// every dashboard built from this repo, served to anyone who loads the page,
// signed in or not. The token was therefore public, and the host was a
// per-store functional URL sitting in shared engine code (R5 / R15), so every
// other store's dashboard pointed that page at the first store's tool.
//
// Now: VIDEO_LAUNCHER_URL + VIDEO_LAUNCHER_TOKEN are store data read at request
// time (R7) through config/storeConfig.js. Neither ever reaches the client.
//
// ── WHY `app` IS A REDIRECT AND NOT A PROXIED DOCUMENT ─────────────────────
// This was measured against the launcher's own source, not assumed. The tool is
// a Vite SPA that bootstraps its role from the query string:
//
//   client/src/api/client.js  — reads `?access=` out of window.location.search,
//                               puts it in localStorage under 'mb_access',
//                               strips it from the address bar, and sends it as
//                               the X-Access-Token header on every /api call.
//   server/src/server.js:85-86 — role is resolved from X-Access-Token or the
//                               ?access= query; static files are public, /api
//                               is not.
//
// So the token must arrive at a document served from the LAUNCHER'S OWN ORIGIN:
// that is where its localStorage lives and where its same-origin /api/* calls
// go. A document proxied through this server would store the token on the
// dashboard's origin and then fire /api/* at the dashboard, which serves a
// different API. Proxying the whole tool (assets, API, websockets) is the
// general-purpose proxy this slice is explicitly not allowed to build, and
// rewriting the launcher is out of lane.
//
// Therefore `app` answers 302 and the token travels in the Location header of a
// response that only an authenticated operator holding brief-pipeline:access
// can obtain. That is the whole of the improvement and it is worth stating
// plainly: the exposure goes from "anyone on the internet who fetches a .js
// file" to "the operators the launcher already grants admin to". The token is
// still absent from every response BODY and every log line, and absent from the
// bundle entirely — which is what the greps in scripts/w9-bundle-grep.sh check.
//
// ── SSRF POSTURE ───────────────────────────────────────────────────────────
// Same posture as server/tests/money-path/ssrf-guard.mjs guards on the checkout
// side, and the SAME function: services/trackingDelivery.js `endpointAllowed`.
// The host is never user-supplied — it comes from env — but env is operator
// input and R7 says it is re-read every request, so it is re-validated every
// request too. The PATH is not user-supplied either: `:target` selects a member
// of TARGETS below and nothing else is reachable. Outbound fetches use
// `redirect: 'manual'` so a 302 upstream cannot walk a validated host to an
// unvalidated one carrying the token with it.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { videoLauncherUrl, videoLauncherToken, videoLauncher } from '../config/storeConfig.js';
import { endpointAllowed } from '../services/trackingDelivery.js';
import logger from '../utils/logger.js';

const router = Router();

// The page is reached behind PageGate permission="brief-pipeline:access"
// (client/src/App.jsx). The server asks the same question rather than trusting
// that gate, because the gate is client-side.
const guard = [authenticate, requirePermission('brief-pipeline', 'access')];

// ── THE ALLOWLIST ──────────────────────────────────────────────────────────
// Exactly the two upstream endpoints ClickupPipeline.jsx called on hub/main:
// the tool's root document (the iframe / "open in new tab" target) and /health
// (the 15 s liveness poll). Nothing else is reachable through this router, and
// there is no parameter anywhere that can add a host, a path or a query.
// A MAP, not an object literal. With a literal, a plain key lookup also answers
// every inherited Object.prototype key: measured 2026-09-11, `constructor`,
// `__proto__`, `toString` and `valueOf` all came back TRUTHY, sailed past the
// `if (!target)` guard, and reached the fetch branch with `path === undefined` —
// i.e. a request to `<launcher>undefined` carrying the admin token. A Map has no
// prototype chain to inherit from, so an unlisted name is `undefined`, full stop.
const TARGETS = new Map([
  // the SPA document — needs the token in the query, see the header note
  ['app',    { path: '/',       mode: 'redirect' }],
  // liveness — plain GET, token attached as a HEADER (never in a URL)
  ['health', { path: '/health', mode: 'proxy' }],
]);
const ALLOWED_TARGETS = [...TARGETS.keys()];

const HEALTH_TIMEOUT_MS = 6000;

/** 503 body when the store has no launcher. Names the keys, never a value. */
const notConfigured = (res) =>
  res.status(503).json({
    error: 'video_launcher_not_configured',
    configured: false,
    message:
      'This store has no video launcher. Set VIDEO_LAUNCHER_URL and VIDEO_LAUNCHER_TOKEN on this service to enable the page.',
    missing: {
      VIDEO_LAUNCHER_URL: videoLauncherUrl() === null,
      VIDEO_LAUNCHER_TOKEN: videoLauncherToken() === '',
    },
  });

/**
 * GET /api/v1/video-launcher/status
 *
 * The ONE question the client asks. Answers whether this store has a launcher
 * and whether it is up. It returns no url and no token — the client does not
 * learn where the tool lives, only that its own /open/app will get there.
 */
router.get('/status', ...guard, async (req, res) => {
  const cfg = videoLauncher(); // { url_set, token_set, configured } — booleans only
  if (!cfg.configured) {
    return res.json({ configured: false, healthy: null, reason: 'not_configured', missing: {
      VIDEO_LAUNCHER_URL: !cfg.url_set,
      VIDEO_LAUNCHER_TOKEN: !cfg.token_set,
    } });
  }
  const probe = await callUpstream('health');
  if (probe.error) {
    // `probe.error` is a CLASS ('unsafe_url:blocked_host', 'network', 'timeout'),
    // never an exception message: undici quotes the request target in its cause,
    // and the request target is the one string that must not be echoed.
    return res.json({ configured: true, healthy: false, reason: probe.error });
  }
  return res.json({ configured: true, healthy: probe.status >= 200 && probe.status < 400, reason: null });
});

/**
 * GET /api/v1/video-launcher/open/:target
 *
 * `app`    → 302 into the launcher with the token attached server-side.
 * `health` → the upstream /health answer, proxied.
 * anything else → 400. `:target` is the only caller-supplied value in this file
 * and it is never interpolated into anything: it is a key lookup, so an
 * unlisted value cannot become a path, a host or a query.
 */
router.get('/open/:target', ...guard, async (req, res) => {
  const target = TARGETS.get(req.params.target);
  if (!target) {
    return res.status(400).json({
      error: 'target_not_allowed',
      allowed: ALLOWED_TARGETS,
      message: 'This route reaches only the endpoints the pipeline page uses.',
    });
  }

  const base = videoLauncherUrl();
  const token = videoLauncherToken();
  if (!base || !token) return notConfigured(res);

  if (target.mode === 'redirect') {
    // Validate the token-FREE url. The guard decides on scheme + host, which the
    // query cannot change, so this is the same decision — taken on a string the
    // token was never interpolated into. One fewer place it can exist.
    const allowed = await endpointAllowed(`${base}${target.path}`);
    if (allowed !== true) {
      // The URL is NOT logged and NOT returned: it carries the token.
      logger.warn(`[videoLauncher] VIDEO_LAUNCHER_URL refused by the SSRF guard (${allowed})`);
      return res.status(502).json({ error: 'upstream_refused', reason: String(allowed) });
    }
    // No caching anywhere: the Location carries a credential.
    res.set('Cache-Control', 'no-store, private');
    res.set('Referrer-Policy', 'no-referrer');
    // NOT res.redirect(). Express's redirect helper writes a courtesy BODY —
    // `Found. Redirecting to <the full url>` — which put the token in the
    // response body. Caught red by D9 in server/tests/video-launcher/route.mjs.
    // The Location header is the entire answer; there is no body.
    return res
      .status(302)
      .location(`${base}${target.path}?access=${encodeURIComponent(token)}`)
      .end();
  }

  const out = await callUpstream(req.params.target);
  if (out.error) return res.status(502).json({ error: 'upstream_unreachable', reason: out.error });
  res.set('Cache-Control', 'no-store, private');
  return res.status(out.status).type('text/plain').send(out.body);
});

/**
 * Call one allowlisted upstream endpoint with the token in a HEADER.
 * Never throws, never returns the url, never returns the token. The body is
 * capped: an upstream that answers a megabyte of html must not become this
 * service's response.
 */
async function callUpstream(name) {
  const target = TARGETS.get(name);
  if (!target) return { error: 'target_not_allowed' };
  const base = videoLauncherUrl();
  const token = videoLauncherToken();
  if (!base || !token) return { error: 'not_configured' };

  const url = `${base}${target.path}`;
  const allowed = await endpointAllowed(url);
  if (allowed !== true) return { error: `unsafe_url:${allowed}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-Access-Token': token, Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    let body = '';
    try { body = await resp.text(); } catch { body = ''; }
    return { status: resp.status, body: String(body).slice(0, 2000) };
  } catch (err) {
    // err.message from undici can quote the request target. It is classified,
    // never echoed — the target is the string that must not leak (R20).
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { error: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export default router;
export { TARGETS, ALLOWED_TARGETS };
