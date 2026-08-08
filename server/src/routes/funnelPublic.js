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
import { pgQuery } from '../db/pg.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { renderPageHtml } from '../services/funnelRender.js';
import { ensureTables, getEnabledRedirects, pickRedirect } from './funnels.js';

const router = Router();

// Feature flag — read per request, deliberately NOT hoisted to module scope.
const publicEnabled = () =>
  ['1', 'true', 'yes', 'on'].includes(
    String(process.env.FUNNEL_PUBLIC_ENABLED || '').trim().toLowerCase()
  );

// ?preview=1 + valid Bearer access token ⇒ drafts are viewable.
// Any verification failure degrades to anonymous (published-only), never 500.
function isPreviewAuthorized(req) {
  if (String(req.query.preview || '') !== '1') return false;
  const authHeader = req.headers.authorization || '';
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return false;
  try {
    verifyAccessToken(parts[1]);
    return true;
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
    await ensureTables();
    const funnelSlug = String(req.params.funnelSlug || '');
    const funnels = await pgQuery(
      `SELECT * FROM funnels WHERE slug = $1 AND archived = FALSE`,
      [funnelSlug]
    );
    const funnel = funnels[0];
    if (!funnel) return notFound(res);

    // ---- Redirect resolution BEFORE page lookup ----
    // Exact beats longest-prefix; only enabled rows; the request's query string
    // is carried through to the destination. Fail-open: a redirect-load error
    // must degrade to normal serving, never 500 a live page.
    const relPath = relativePath(req, funnelSlug);
    try {
      const redirects = await getEnabledRedirects(funnel.id);
      const hit = pickRedirect(redirects, relPath);
      if (hit) {
        const qs = rawQueryString(req);
        let location = String(hit.to_path);
        if (qs) location += (location.includes('?') ? '&' : '?') + qs;
        const code = Number(hit.code) === 302 ? 302 : 301;
        res.set('Cache-Control', 'no-store'); // non-200 stays no-store
        res.set('Location', location);
        return res.status(code).type('text/plain').send('Redirecting');
      }
    } catch (rErr) {
      console.error('[funnelPublic] redirect resolution failed (fail-open):', rErr.message);
    }

    const preview = isPreviewAuthorized(req);
    const page = await resolvePage(funnel);
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
