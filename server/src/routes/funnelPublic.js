// Funnel Builder — slice 2: UNAUTHENTICATED public page serving.
//
//   GET /f/:funnelSlug            → home page (is_home, else default_page_id)
//   GET /f/:funnelSlug/:pageSlug  → that page
//
// Non-negotiable rules ported from the reference (funnel-os DECISIONS.md
// items 13/16/17 + ARCHITECTURE.md §3):
//  • The entire feature sits behind FUNNEL_PUBLIC_ENABLED, read AT REQUEST
//    TIME (not module load) — unset/false ⇒ 404. Flipping the env var and
//    restarting must never require a code change, and a booted process must
//    honour the current value.
//  • Serve only status='published', non-archived pages of non-archived
//    funnels. Drafts 404.
//  • EVERY non-200 sets `Cache-Control: no-store` — a cached 404 on a page
//    just published is an hours-long outage. 200s set `private, no-store`
//    (no caching at all until the cache slice lands).
//  • ?preview=1 with a valid Bearer access token may view drafts —
//    always no-store. Invalid/missing token ⇒ the same 404 as anonymous
//    (no oracle for which slugs exist).
//  • Serving fails OPEN page-wise (bad blocks degrade inside the renderer)
//    but a DB/render failure here returns 500 + no-store, never a hang.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { pgQuery } from '../db/pg.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { renderPageHtml } from '../services/funnelRender.js';
import { ensureTables, getEnabledRedirects, pickRedirect } from './funnels.js';
import { resolvePageSplit, recordView } from '../services/splitDelivery.js';

const router = Router();

// #7: the public surface is unauthenticated and revenue-adjacent — rate-limit
// per IP (generous; real pages get legit bursts) as DoS defence-in-depth.
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    // A 429 with no Cache-Control is heuristically cacheable by a shared cache
    // — and a burst is exactly when you are paying for the traffic. Every other
    // non-200 exit here sets no-store; the limiter needs its own handler to.
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).type('text/plain').send('Too many requests');
    },
  })
);

// Feature flag — read per request, deliberately NOT hoisted to module scope.
const publicEnabled = () =>
  ['1', 'true', 'yes', 'on'].includes(
    String(process.env.FUNNEL_PUBLIC_ENABLED || '').trim().toLowerCase()
  );

// ?preview=1 + valid Bearer access token WITH funnels:access ⇒ drafts viewable.
// #3: signature validity is NOT enough — a Viewer-role token must not read
// drafts. Require the funnels permission (or a wildcard) in the decoded token.
// Any verification/permission failure degrades to anonymous, never 500.
function tokenHasFunnelsAccess(payload) {
  const roles = payload?.roles || [];
  for (const role of roles) {
    let perms = role?.permissions;
    if (!perms) continue;
    if (typeof perms === 'string') {
      try { perms = JSON.parse(perms); } catch { continue; }
    }
    if (Array.isArray(perms['*']) && perms['*'].includes('*')) return true;
    const f = perms.funnels;
    if (Array.isArray(f) && (f.includes('*') || f.includes('access'))) return true;
  }
  return false;
}

function isPreviewAuthorized(req) {
  if (String(req.query.preview || '') !== '1') return false;
  const authHeader = req.headers.authorization || '';
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return false;
  try {
    const payload = verifyAccessToken(parts[1]);
    return tokenHasFunnelsAccess(payload);
  } catch {
    return false;
  }
}

const notFound = (res) => {
  res.set('Cache-Control', 'no-store');
  res.status(404).type('text/plain').send('Not found');
};

// Funnel-relative path (no query string) for redirect matching. `req.path` is
// mount-relative ('/f' already stripped), e.g. '/slug/old' → '/old'. The funnel
// root ('/f/slug') maps to '/'.
function relativePath(req, funnelSlug) {
  const rel = String(req.path || '').slice(1 + funnelSlug.length);
  return rel || '/';
}

// Raw query string preserved verbatim from the request (attribution depends on
// it surviving the redirect). Returns '' or 'a=1&b=2' (no leading '?').
function rawQueryString(req) {
  const url = String(req.originalUrl || req.url || '');
  const q = url.indexOf('?');
  return q === -1 ? '' : url.slice(q + 1);
}

async function servePage(req, res, resolvePage) {
  // Flag check FIRST — flag off means this surface does not exist.
  if (!publicEnabled()) return notFound(res);
  try {
    // #6: null bytes (and any control chars) in the path must never reach the
    // DB (Postgres 22021) — reject on the public surface before any query.
    if (/[\x00-\x1f]/.test(req.path || '') || /%00/i.test(req.originalUrl || '')) {
      return notFound(res);
    }
    await ensureTables();
    const funnelSlug = String(req.params.funnelSlug || '');
    // Funnel slugs are [a-z0-9-]+ by construction — anything else can't exist,
    // so short-circuit to 404 (also defuses traversal/unicode/null probes).
    if (!/^[a-z0-9-]+$/.test(funnelSlug)) return notFound(res);
    const funnels = await pgQuery(
      `SELECT * FROM funnels WHERE slug = $1 AND archived = FALSE`,
      [funnelSlug]
    );
    const funnel = funnels[0];
    if (!funnel) return notFound(res);

    const preview = isPreviewAuthorized(req);
    // #1: funnel-level publish gate. A draft funnel is fully dark to the public
    // — it serves nothing AND does not even redirect — unless an authorized
    // operator is previewing. The page-level gate alone left published pages of
    // a draft funnel exposed.
    if (!preview && funnel.status !== 'published') return notFound(res);

    // ---- Redirect resolution BEFORE page lookup (live serving only) ----
    // Exact beats longest-prefix; only enabled rows; the request's query string
    // is carried through. Skipped in preview (the operator wants the page, not a
    // hop). Fail-open: a redirect-load error degrades to normal serving.
    if (!preview) {
      const relPath = relativePath(req, funnelSlug);
      try {
        const redirects = await getEnabledRedirects(funnel.id);
        const hit = pickRedirect(redirects, relPath);
        if (hit) {
          const qs = rawQueryString(req);
          const rel = String(hit.to_path);
          // Mirror funnelRender's toPublic(): keep the funnel prefix unless the
          // request already arrived on a custom host rooted at the funnel.
          const onCustomHost = Boolean(req.customDomainFunnelId);
          const base = onCustomHost ? '' : `/f/${funnelSlug}`;
          let location = rel === '/' ? (base || '/') : `${base}${rel}`;
          if (qs) location += (location.includes('?') ? '&' : '?') + qs;
          const code = Number(hit.code) === 302 ? 302 : 301;
          res.set('Cache-Control', 'no-store'); // non-200 stays no-store
          res.set('Location', location);
          return res.status(code).type('text/plain').send('Redirecting');
        }
      } catch (rErr) {
        console.error('[funnelPublic] redirect resolution failed (fail-open):', rErr.message);
      }
    }

    // ---- SPLIT DELIVERY: a live page-scope test's handle owns its route ----
    // (live serving only — preview always shows the exact page the operator
    // asked for). The visitor's arm is a sticky pure hash of (visitor id,
    // test id); the arm's page is served INLINE at the handle. First-touch
    // visitors get their id minted HERE — the client tracking script mints it
    // too late for the very first render, and without an id every first view
    // would land on the entry arm. Fail-open: any error inside resolves to
    // null and the request falls through to normal slug serving.
    let page = null;
    if (!preview) {
      const relPath = relativePath(req, funnelSlug);
      let visitorId = String(req.cookies?._fos_vid || '');
      const needsMint = !visitorId;
      if (needsMint) visitorId = `v_${crypto.randomBytes(12).toString('hex')}`;
      const split = await resolvePageSplit({ funnelId: funnel.id, relPath, visitorId });
      if (split) {
        if (needsMint) {
          // Same cookie the client runtime mints (name/path/lifetime/SameSite;
          // NOT HttpOnly — trackingRuntime reads it back for beacons). secure
          // only in production, matching the checkout cookie's pattern — an
          // unconditional flag makes plain-HTTP dev drop it, re-rolling the
          // arm every request.
          res.cookie('_fos_vid', visitorId, {
            maxAge: 365 * 864e5, path: '/', sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
          });
        }
        // The delivered render is the visitor count (funnel-os counts the
        // impression on delivery). Fire-and-forget — never delays the page.
        // A PAUSED test serves unbranched: no view, no measurement.
        if (!split.paused) {
          recordView({ testId: split.test.id, armKey: split.arm.arm_key, visitorId })
            .catch(() => {});
        }
        page = split.page; // already published + not archived, by query
      }
    }

    if (!page) page = await resolvePage(funnel);
    if (!page || page.archived) return notFound(res);
    if (!preview && page.status !== 'published') return notFound(res);

    // Live-page slug map so the renderer can turn flow_layout edges (keyed by
    // page id) into path-based routing. Archived/missing targets are absent →
    // the flow compiler omits them (fail-open).
    const allPages = await pgQuery(
      `SELECT id, slug FROM funnel_pages WHERE funnel_id = $1 AND archived = FALSE`,
      [funnel.id]
    );
    const pagesById = new Map(allPages.map((p) => [p.id, { slug: p.slug }]));

    const html = renderPageHtml(page, funnel, pagesById);
    // No caching until the cache slice: private + no-store on every 200.
    res.set('Cache-Control', 'private, no-store');
    res.status(200).type('text/html; charset=utf-8').send(html);
  } catch (err) {
    console.error('[funnelPublic] serve failed:', err);
    res.set('Cache-Control', 'no-store');
    res.status(500).type('text/plain').send('Server error');
  }
}

// GET /f/:funnelSlug — home page: is_home, else funnel.default_page_id, else 404
router.get('/:funnelSlug', (req, res) => {
  servePage(req, res, async (funnel) => {
    const home = await pgQuery(
      `SELECT * FROM funnel_pages
       WHERE funnel_id = $1 AND archived = FALSE AND is_home = TRUE
       LIMIT 1`,
      [funnel.id]
    );
    if (home[0]) return home[0];
    if (funnel.default_page_id) {
      const fallback = await pgQuery(
        `SELECT * FROM funnel_pages
         WHERE id = $1 AND funnel_id = $2 AND archived = FALSE`,
        [funnel.default_page_id, funnel.id]
      );
      return fallback[0] || null;
    }
    return null;
  });
});

// GET /f/:funnelSlug/:pageSlug — stored page slugs carry a leading '/'
router.get('/:funnelSlug/:pageSlug', (req, res) => {
  servePage(req, res, async (funnel) => {
    const slug = `/${String(req.params.pageSlug || '')}`;
    const rows = await pgQuery(
      `SELECT * FROM funnel_pages
       WHERE funnel_id = $1 AND slug = $2 AND archived = FALSE`,
      [funnel.id, slug]
    );
    return rows[0] || null;
  });
});

// GET /f/:funnelSlug/<nested...> — page slugs are single-segment, so a deeper
// path can only be a (prefix) redirect target. servePage runs redirect
// resolution first; with no page here, a miss falls through to 404 (no-store).
// Declared LAST so the single-segment page route above wins for two-segment
// requests.
router.get('/:funnelSlug/{*splat}', (req, res) => {
  servePage(req, res, async () => null);
});

export default router;
