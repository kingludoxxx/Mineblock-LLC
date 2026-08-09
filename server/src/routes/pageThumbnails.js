// Page thumbnails — live miniatures for the funnel canvas nodes.
//
// GET /api/v1/page-thumbnails/:funnelId/:pageId.png
//   -> 200 image/jpeg   (fresh or cached shot of the rendered page)
//   -> 202 {pending}    (uncached + both screenshot slots busy — client retries)
//   -> 204              (render/screenshot failed — client keeps its placeholder)
//   -> 404              (funnel/page not found)
//
// The canvas must NEVER 500 because of a thumbnail: every failure past auth is
// fail-open (204). Screenshots run the page's operator-authored JS inside the
// chromium sandbox with all non-asset network aborted (images/css/fonts over
// http(s) are allowed so pages look right; xhr/fetch/doc navigation are not).
//
// Caching (mandatory — a browser launch per request would melt the dyno):
//   - ONE shared chromium instance, lazy-launched, reused across requests
//     (browser.newPage per shot, always closed in finally).
//   - memory + disk cache keyed by pageId + the page's updated_at; files live
//     under os.tmpdir()/page-thumbs/ as <pageId>-<updatedAtMs>.jpg. A page
//     edit bumps updated_at -> new key -> stale files deleted opportunistically.
//   - at most 2 simultaneous screenshots (semaphore); overflow -> 202.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { chromium } from 'playwright';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTables } from './funnels.js';
import { renderPageHtml } from '../services/funnelRender.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// Viewport matches the reference tool's portrait miniatures.
const SHOT = { width: 400, height: 600, quality: 60, settleMs: 500, timeoutMs: 8000 };
const CACHE_DIR = path.join(os.tmpdir(), 'page-thumbs');
const CACHE_MAX_AGE = 300; // seconds, Cache-Control
const MEM_CACHE_MAX = 200; // entries; simple FIFO eviction
// Idle-close: with no shots for this long the shared chromium is closed and
// the next request relaunches lazily (getBrowser self-heals). On the 512MB
// dyno this keeps the two-browsers window (this + the ad-library extractor's
// own chromium) down to active use only. Env override exists for the tests.
const IDLE_CLOSE_MS = Number(process.env.THUMB_BROWSER_IDLE_MS || 60_000);

// Test/observability hooks — the verification harness counts these to prove
// the cache short-circuits (second call must not add a screenshot) and that
// the private-host filter actually fires.
export const _stats = { launches: 0, screenshots: 0, abortedPrivate: 0 };

// ---------------------------------------------------------------------------
// Shared chromium (lazy singleton). Same production concern as
// fbAdLibraryExtractor: Render's postinstall puts browsers in
// <repo>/playwright-browsers but the runtime env var isn't propagated, so
// executablePath() can point at an empty default. Try the default launch
// first (correct on dev machines), then search the known install roots.
// ---------------------------------------------------------------------------
function findChromiumBinary() {
  const roots = [
    path.join(process.cwd(), 'playwright-browsers'),
    '/opt/render/project/src/playwright-browsers',
    '/opt/render/.cache/ms-playwright',
  ];
  for (const baseDir of roots) {
    if (!existsSync(baseDir)) continue;
    try {
      for (const entry of readdirSync(baseDir)) {
        if (!/^chromium(_headless_shell)?-\d+$/.test(entry)) continue;
        const candidates = [
          path.join(baseDir, entry, 'chrome-linux64', 'chrome'),
          path.join(baseDir, entry, 'chrome-linux', 'chrome'),
          path.join(baseDir, entry, 'chrome-linux', 'headless_shell'),
        ];
        for (const p of candidates) if (existsSync(p)) return p;
      }
    } catch { /* keep searching */ }
  }
  return null;
}

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch { /* fall through and relaunch */ }
    browserPromise = null;
  }
  browserPromise = (async () => {
    _stats.launches += 1;
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    try {
      return await chromium.launch({ headless: true, args });
    } catch (err) {
      const exe = findChromiumBinary();
      if (!exe) throw err;
      return chromium.launch({ headless: true, args, executablePath: exe });
    }
  })();
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null; // next request retries the launch
    throw err;
  }
}

export async function closeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try { await (await p).close(); } catch { /* already gone */ }
}

// True while a launched (or launching) browser is held. Test hook for the
// idle-close assertion; also handy for ops introspection.
export function isBrowserActive() {
  return browserPromise !== null;
}

// ---------------------------------------------------------------------------
// Idle-close timer — armed when the last in-flight shot finishes, cleared
// when a new one starts. unref()d so it never holds the process open.
// ---------------------------------------------------------------------------
let idleTimer = null;
let busyShots = 0;

function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (busyShots === 0) closeBrowser().catch(() => {});
  }, IDLE_CLOSE_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

// ---------------------------------------------------------------------------
// Private/loopback host guard — defense-in-depth for the shot's request
// filter. JS is disabled in the shot page, but markup alone (img/css/font
// URLs) could still probe the dyno's network; anything resolving to
// loopback/link-local/RFC1918 space is aborted.
// ---------------------------------------------------------------------------
export function isPrivateHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // unparseable → treat as hostile
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]' || host === '::') return true;
  if (/^127\./.test(host)) return true;      // loopback
  if (/^10\./.test(host)) return true;       // RFC1918
  if (/^192\.168\./.test(host)) return true; // RFC1918
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true; // RFC1918
  if (/^169\.254\./.test(host)) return true; // link-local / cloud metadata
  if (host.startsWith('[')) return true;     // any other IPv6 literal — refuse
  return false;
}

// ---------------------------------------------------------------------------
// Screenshot core (exported for the verification harness).
// ---------------------------------------------------------------------------

// Renders arbitrary page HTML in a fresh chromium page and returns a JPEG
// Buffer. Throws on failure — generateThumbnail is the fail-open wrapper.
export async function screenshotHtml(html) {
  // Mark busy BEFORE the (possibly pending) launch so the idle timer can
  // never close the browser out from under a shot that is starting.
  busyShots += 1;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      viewport: { width: SHOT.width, height: SHOT.height },
      deviceScaleFactor: 1,
      // Thumbnails don't need JS. Disabling it kills the two worst hostile
      // cases at once: operator scripts probing the dyno's network from
      // inside chromium (SSRF/exfil), and while(true) loops pinning a shot
      // slot until timeout. Runtime-filled UI (order summaries etc.) shows
      // as its static placeholder in the miniature — accepted trade.
      javaScriptEnabled: false,
    });
    page.setDefaultTimeout(SHOT.timeoutMs);
    // The network is nearly closed: only http(s)/data images/stylesheets/
    // fonts load (so the page looks right) and NEVER from private/loopback
    // space; documents, xhr/fetch, and everything else abort. Navigation
    // attempts therefore dead-end too.
    await page.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url();
      const isAsset = type === 'image' || type === 'stylesheet' || type === 'font';
      if (!isAsset) return route.abort();
      if (/^data:/i.test(url)) return route.continue();
      if (!/^https?:/i.test(url)) return route.abort();
      if (isPrivateHost(url)) {
        _stats.abortedPrivate += 1;
        return route.abort();
      }
      return route.continue();
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    // domcontentloaded + a short settle — networkidle is deliberately NOT
    // awaited (an aborted request stream can keep a page "busy" forever).
    await page.setContent(String(html || ''), {
      waitUntil: 'domcontentloaded',
      timeout: SHOT.timeoutMs,
    });
    await page.waitForTimeout(SHOT.settleMs);
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: SHOT.quality,
      fullPage: false,
      timeout: SHOT.timeoutMs,
    });
    _stats.screenshots += 1;
    return buf;
  } finally {
    if (page) await page.close().catch(() => {});
    busyShots -= 1;
    if (busyShots === 0) armIdleClose();
  }
}

// Render + screenshot one funnel page. Fail-open: any error -> null (the
// route answers 204 and the canvas keeps its placeholder).
export async function generateThumbnail(page, funnel, pagesById) {
  // Resolve the id for logging OUTSIDE the main catch — a hostile/broken row
  // can throw on property access, and the error path must never throw.
  let pid = 'unknown';
  try { pid = String(page?.id ?? 'unknown'); } catch { /* keep 'unknown' */ }
  try {
    const html = renderPageHtml(page, funnel, pagesById);
    return await screenshotHtml(html);
  } catch (err) {
    console.error(
      `[pageThumbnails] render/shot failed for page ${pid} (fail-open):`,
      err?.message || err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache (memory Map + disk files under os.tmpdir()/page-thumbs).
// ---------------------------------------------------------------------------
const memCache = new Map(); // pageId -> { key, buf }

const safeName = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '_');

export function cacheKeyFor(page) {
  const ms = new Date(page?.updated_at || 0).getTime();
  return `${safeName(page?.id)}-${Number.isFinite(ms) ? ms : 0}`;
}

export function readCache(page) {
  const key = cacheKeyFor(page);
  const hit = memCache.get(page.id);
  if (hit && hit.key === key) return hit.buf;
  const file = path.join(CACHE_DIR, `${key}.jpg`);
  try {
    if (existsSync(file)) {
      const buf = readFileSync(file);
      memSet(page.id, key, buf);
      return buf;
    }
  } catch { /* disk cache is best-effort */ }
  return null;
}

function memSet(pageId, key, buf) {
  if (!memCache.has(pageId) && memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(pageId, { key, buf });
}

export function writeCache(page, buf) {
  const key = cacheKeyFor(page);
  memSet(page.id, key, buf);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path.join(CACHE_DIR, `${key}.jpg`), buf);
    // Opportunistic stale sweep: older shots of THIS page only.
    const prefix = `${safeName(page.id)}-`;
    for (const f of readdirSync(CACHE_DIR)) {
      if (f.startsWith(prefix) && f !== `${key}.jpg`) {
        try { unlinkSync(path.join(CACHE_DIR, f)); } catch { /* raced */ }
      }
    }
  } catch (err) {
    // Memory cache still holds it — disk is an optimization, not a contract.
    console.error('[pageThumbnails] disk cache write failed:', err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// In-flight dedupe: concurrent uncached requests for the SAME page (same
// cache key) await ONE screenshot instead of consuming two slots. The map
// entry is set synchronously on first call and cleared when the render
// settles, so JS's single thread guarantees exactly one producer per key.
// Exported for the verification harness.
// ---------------------------------------------------------------------------
const inflight = new Map(); // cacheKey -> Promise<Buffer|null>

export function inflightFor(page) {
  return inflight.get(cacheKeyFor(page)) || null;
}

export function renderAndCacheDeduped(page, funnel, pagesById) {
  const key = cacheKeyFor(page);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const buf = await generateThumbnail(page, funnel, pagesById);
      if (buf) writeCache(page, buf);
      return buf;
    })();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => {});
  }
  return p;
}

// ---------------------------------------------------------------------------
// Concurrency guard: at most 2 simultaneous screenshots. Overflow answers
// 202 {pending:true} and the client retries — queueing here would pile
// request handlers up behind a slow chromium.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_SHOTS = 2;
let activeShots = 0;
const tryAcquireShot = () => (activeShots >= MAX_CONCURRENT_SHOTS ? false : (activeShots += 1, true));
const releaseShot = () => { activeShots = Math.max(0, activeShots - 1); };

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
function sendJpeg(res, buf) {
  res.set('Cache-Control', `private, max-age=${CACHE_MAX_AGE}`);
  return res.status(200).type('image/jpeg').send(buf);
}

// GET /:funnelId/:pageId.png — the .png suffix keeps the URL image-shaped;
// the body is JPEG (smaller at q60 than PNG for real pages) and the client
// reads the blob's actual content type.
router.get('/:funnelId/:pageId.png', async (req, res) => {
  try {
    await ensureTables();
    const { funnelId, pageId } = req.params;

    // Same read path as funnels.js / funnelPublic.js: funnel row + page row
    // scoped to the funnel, archived pages excluded.
    const funnelRows = await pgQuery(`SELECT * FROM funnels WHERE id = $1`, [funnelId]);
    const funnel = funnelRows[0];
    if (!funnel || funnel.archived) return res.status(404).json({ error: 'Funnel not found' });

    const pageRows = await pgQuery(
      `SELECT * FROM funnel_pages WHERE funnel_id = $1 AND id = $2 AND archived = FALSE`,
      [funnelId, pageId]
    );
    const page = pageRows[0];
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const cached = readCache(page);
    if (cached) return sendJpeg(res, cached);

    // Same page already rendering? Join it — no slot needed, one screenshot.
    const joined = inflightFor(page);
    if (joined) {
      const buf = await joined;
      return buf ? sendJpeg(res, buf) : res.status(204).end();
    }

    if (!tryAcquireShot()) return res.status(202).json({ pending: true });

    let buf = null;
    try {
      // Slug map mirrors funnelPublic's serve path so flow-compiled links
      // resolve the same way they do on the live render.
      const allPages = await pgQuery(
        `SELECT id, slug FROM funnel_pages WHERE funnel_id = $1 AND archived = FALSE`,
        [funnelId]
      );
      const pagesById = new Map(allPages.map((p) => [p.id, { slug: p.slug }]));
      buf = await renderAndCacheDeduped(page, funnel, pagesById); // caches on success
    } finally {
      releaseShot();
    }

    if (!buf) return res.status(204).end(); // fail-open — placeholder stays
    return sendJpeg(res, buf);
  } catch (err) {
    // NEVER 500 the canvas over a thumbnail.
    console.error('[pageThumbnails] request failed (fail-open):', err?.message || err);
    return res.status(204).end();
  }
});

export default router;
