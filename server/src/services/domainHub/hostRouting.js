// Domain Hub — per-HOST funnel resolution (the serving side of lb_domains).
//
// Mirrors funnel-os's model (DATA-MODEL.md / SETUP.md step 5): a published
// page still 404s until the requested HOST has a connected lb_domains row.
// Serving is per-host; publish status is per-page.
//
// ── INTEGRATION HOOK (documented, NOT wired — Ludo wires at merge) ─────────
// app.js placement — BEFORE the SPA fallback and BEFORE the /f mount, after
// cookie/body parsers:
//
//     import { customDomainMiddleware } from './services/domainHub/hostRouting.js';
//     app.use(customDomainMiddleware());          // ← here
//     app.use('/f', funnelPublicRoutes);          // existing mount
//     …SPA fallback last…
//
// The middleware resolves req.hostname against connected lb_domains rows
// (30s in-process cache). On a match it rewrites req.url to the funnel's
// /f/<slug>… form and falls through, so funnelPublic.js serves the funnel
// EXACTLY as it does today — same publish gates, same redirects, same
// no-store rules — with zero changes to funnelPublic itself. `/` on a custom
// host becomes `/f/<slug>` (the funnel home: is_home else default_page_id).
// A non-matching host falls through untouched (admin SPA / 404) — fail-open,
// per funnel-os DECISIONS #16: a resolution error must never take the app
// down.
//
// App hosts (localhost, the Render host, APP_HOSTS env) short-circuit before
// any DB lookup so admin traffic never pays a query.
import { pgQuery } from '../../db/pg.js';
import { ensureDomainTables } from './schema.js';

const CACHE_TTL_MS = 30_000;
const CACHE_CAP = 5000; // host keys are attacker-influenced — bound the map
const cache = new Map(); // host → { expires, value: {funnelId, slug} | null }

function appHosts() {
  const hosts = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
  const target = String(process.env.RENDER_TARGET_HOST || 'puure-dashboard.onrender.com').trim().toLowerCase();
  if (target) hosts.add(target);
  for (const h of String(process.env.APP_HOSTS || '').split(',')) {
    const t = h.trim().toLowerCase();
    if (t) hosts.add(t);
  }
  return hosts;
}

export function normalizeHost(raw) {
  return String(raw || '').split(',')[0].split(':')[0].trim().toLowerCase().replace(/\.+$/, '');
}

function cacheGet(host) {
  const hit = cache.get(host);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) { cache.delete(host); return undefined; }
  return hit.value;
}

function cacheSet(host, value) {
  if (cache.size >= CACHE_CAP) {
    // Evict oldest-inserted first (Map preserves insertion order).
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size < CACHE_CAP) break;
    }
  }
  cache.set(host, { expires: Date.now() + CACHE_TTL_MS, value });
}

/** Drop a host (and its www/apex sibling) from the cache — called on every
 *  attach/verify/detach mutation so config changes land promptly. No arg =
 *  clear all. */
export function invalidateHostCache(host = null) {
  if (host === null) { cache.clear(); return; }
  const norm = normalizeHost(host);
  cache.delete(norm);
  const sibling = norm.startsWith('www.') ? norm.slice(4) : 'www.' + norm;
  cache.delete(sibling);
}

async function lookupHost(host) {
  const rows = await pgQuery(
    `SELECT d.funnel_id, f.slug
     FROM lb_domains d
     JOIN funnels f ON f.id = d.funnel_id AND f.archived = FALSE
     WHERE d.domain = $1 AND d.status = 'connected'
     LIMIT 1`,
    [host]
  );
  if (!rows[0]) return null;
  return { funnelId: rows[0].funnel_id, slug: rows[0].slug };
}

/**
 * Resolve a hostname to its connected funnel: { funnelId, slug } | null.
 * Exact host first, then the www/apex sibling (a customer pointing both
 * apex and www at us gets the same funnel on either — funnel-os semantics).
 * Cached ~30s including negative results. Fail-open: any DB error → null.
 */
export async function resolveCustomHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host || appHosts().has(host)) return null;
  const cached = cacheGet(host);
  if (cached !== undefined) return cached;
  let value = null;
  try {
    await ensureDomainTables();
    value = await lookupHost(host);
    if (!value) {
      const sibling = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
      if (sibling !== host) value = await lookupHost(sibling);
    }
  } catch (err) {
    console.error('[domainHub] host resolution failed (fail-open):', err.message);
    return null; // NOT cached — a transient DB error must not stick for 30s
  }
  cacheSet(host, value);
  return value;
}

/**
 * Express middleware (factory) — see the INTEGRATION HOOK block above for
 * exact app.js placement. GET/HEAD only; API/static/asset paths pass
 * through so a funnel on a custom host keeps its runtime calls working.
 */
const PASSTHROUGH_PREFIXES = ['/api', '/assets', '/static', '/f/'];
const ASSET_SUFFIX_RE = /\.(ico|png|jpe?g|gif|svg|webp|css|js|map|txt|xml|json|woff2?|ttf|webmanifest)$/i;

export function customDomainMiddleware() {
  return async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const path = req.path || '/';
      if (PASSTHROUGH_PREFIXES.some((p) => path.startsWith(p)) || ASSET_SUFFIX_RE.test(path)) {
        return next();
      }
      const match = await resolveCustomHost(req.hostname || req.headers.host);
      if (!match) return next();
      // Internal rewrite → the existing /f/:slug serving surface. Query
      // string survives verbatim (attribution depends on it).
      const qIdx = String(req.url).indexOf('?');
      const qs = qIdx === -1 ? '' : String(req.url).slice(qIdx);
      req.url = `/f/${match.slug}${path === '/' ? '' : path}${qs}`;
      req.customDomainFunnelId = match.funnelId;
      return next();
    } catch (err) {
      console.error('[domainHub] middleware failed (fail-open):', err.message);
      return next();
    }
  };
}
