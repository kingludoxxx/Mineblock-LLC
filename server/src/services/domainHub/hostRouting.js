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
// Non-GET/HEAD requests are deliberately NOT rewritten: a funnel's forms and
// runtime calls POST to /api/*, which is a passthrough prefix on every host,
// so nothing on a custom host needs a rewritten POST. A POST to a
// page-relative path on a custom host therefore falls through to the normal
// app (404/SPA) rather than being routed into /f — by design, not oversight.
import { pgQuery } from '../../db/pg.js';
import { ensureDomainTables } from './schema.js';

const CACHE_TTL_MS = 30_000;
// TWO caches, sized independently. The host key is attacker-influenced (any
// client can send any Host), and a flood of DISTINCT junk hosts would
// otherwise evict the handful of REAL connected domains out of a single
// shared map — turning a cheap flood into a per-request DB query for genuine
// traffic. Positive (connected) entries live in their own map that negative
// churn can never evict; negatives get a smaller cap of their own.
const POSITIVE_CAP = 1000; // real connected domains — orders of magnitude more than we'll ever have
const NEGATIVE_CAP = 500;  // junk/unattached hosts — bounded, evicted oldest-first
const positiveCache = new Map(); // host → { expires, value: {funnelId, slug} }
const negativeCache = new Map(); // host → { expires, value: null }

// ── Query seam ──────────────────────────────────────────────────────────────
// Production uses pgQuery directly. Tests inject a counting wrapper to PROVE
// that a junk-host flood executes zero queries.
let queryRunner = pgQuery;
export function setHostQueryRunner(fn) { queryRunner = fn || pgQuery; }
export function resetHostQueryRunner() { queryRunner = pgQuery; }

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

/**
 * Could this string POSSIBLY be a domain we have a row for? Purely
 * syntactic — no I/O. Runs BEFORE any DB round-trip and before any cache
 * insert, so a flood of junk Host values (`../../etc`, 4KB blobs, IPs with
 * ports stripped, unicode) costs a regex and nothing else: no pooled
 * connection, no cache entry, no eviction pressure on real domains.
 * Deliberately stricter than "valid DNS name" only where lb_domains itself
 * is stricter — validate.js stores exactly this shape (lowercased punycode
 * ASCII), so a host that fails here can never match a row.
 */
export function isPlausibleHost(host) {
  if (!host || host.length > 253) return false;
  if (!host.includes('.')) return false;                  // single-label ⇒ never a stored domain
  if (!/^[a-z0-9.-]+$/.test(host)) return false;          // stored domains are ASCII-normalized
  if (host.startsWith('-') || host.endsWith('-')) return false;
  if (host.startsWith('.') || host.endsWith('.')) return false;
  for (const label of host.split('.')) {
    if (!label || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }
  return true;
}

function cacheGet(host) {
  for (const map of [positiveCache, negativeCache]) {
    const hit = map.get(host);
    if (!hit) continue;
    if (hit.expires <= Date.now()) { map.delete(host); continue; }
    return hit.value;
  }
  return undefined;
}

function cacheSet(host, value) {
  const map = value ? positiveCache : negativeCache;
  const cap = value ? POSITIVE_CAP : NEGATIVE_CAP;
  // A host can flip positive↔negative (attach/detach); drop the stale twin so
  // the two maps never disagree.
  (value ? negativeCache : positiveCache).delete(host);
  if (map.size >= cap) {
    // Evict oldest-inserted first (Map preserves insertion order). Bounded to
    // this map only — negative churn can never evict a connected domain.
    for (const k of map.keys()) {
      map.delete(k);
      if (map.size < cap) break;
    }
  }
  map.set(host, { expires: Date.now() + CACHE_TTL_MS, value });
}

/** Drop a host (and its www/apex sibling) from BOTH caches — called on every
 *  attach/verify/detach mutation so config changes land promptly. No arg =
 *  clear all. */
export function invalidateHostCache(host = null) {
  if (host === null) { positiveCache.clear(); negativeCache.clear(); return; }
  const norm = normalizeHost(host);
  const sibling = norm.startsWith('www.') ? norm.slice(4) : 'www.' + norm;
  for (const map of [positiveCache, negativeCache]) {
    map.delete(norm);
    map.delete(sibling);
  }
}

/** Cache occupancy — exposed for tests/ops; never used for control flow. */
export function hostCacheStats() {
  return { positive: positiveCache.size, negative: negativeCache.size };
}

async function lookupHost(host) {
  const rows = await queryRunner(
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
 *
 * Order of the cheap gates, all BEFORE any DB round-trip: app-host
 * short-circuit → syntactic plausibility (isPlausibleHost) → cache. A host
 * that fails the syntactic gate consumes no pooled connection AND leaves no
 * cache entry, so a flood of distinct junk Hosts cannot contend with the
 * admin API for the 10-connection pool or evict real domains.
 */
export async function resolveCustomHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host || appHosts().has(host)) return null;
  if (!isPlausibleHost(host)) return null; // no query, no cache entry
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
