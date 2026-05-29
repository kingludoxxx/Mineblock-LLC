/**
 * Facebook Ad Library video URL extractor (Playwright + warm browser pool).
 *
 * Why this exists: TripleWhale's creative_analysis sync drops the direct
 * video URL for many ads (creative_link / video_url NULL). yt-dlp can't
 * parse FB Ad Library pages because they're JavaScript-rendered SPAs.
 * The video <src> only resolves AFTER the page hydrates. The only reliable
 * path is to render the page in a real browser, intercept the .mp4 network
 * request, and return that CDN URL to the transcribe pipeline.
 *
 * Cold Playwright launches Chromium per request (~5-10s). Unusable.
 * Warm Playwright keeps ONE Chromium alive at boot, opens a new tab per
 * request (~1-2s). Usable.
 *
 * Concurrency: hard cap of 3 tabs at once to fit Render's 2GB RAM budget.
 * Crash recovery: if the browser dies, the next call relaunches it.
 */

// Point Playwright at the build-time install location BEFORE importing the
// browser module. Render's runtime start command doesn't carry forward the
// PLAYWRIGHT_BROWSERS_PATH from build, so chromium.executablePath() defaults
// to /opt/render/.cache/ms-playwright/ — which is empty. The postinstall
// script puts the binaries at <repo>/playwright-browsers/.
import path from 'node:path';
import { existsSync } from 'node:fs';
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.cwd(), 'playwright-browsers');
  console.log(`[fbExtractor] PLAYWRIGHT_BROWSERS_PATH set to ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
}
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

// ── Warm browser singleton ────────────────────────────────────────────────
let _browser = null;
let _browserContext = null;
let _activeTabs = 0;
const MAX_CONCURRENT_TABS = 3;

// Mutex queue so we don't ever blow past MAX_CONCURRENT_TABS
const _waitQueue = [];

async function acquireSlot() {
  if (_activeTabs < MAX_CONCURRENT_TABS) {
    _activeTabs += 1;
    return;
  }
  // Wait for a slot to open
  await new Promise((resolve) => _waitQueue.push(resolve));
  _activeTabs += 1;
}

function releaseSlot() {
  _activeTabs = Math.max(0, _activeTabs - 1);
  const next = _waitQueue.shift();
  if (next) next();
}

// Compute the regular chromium executable path by replacing the
// headless-shell components Playwright 1.59 returns by default.
// We use the full chromium binary because chromium-headless-shell is
// often missing from Render's build cache (silent install failure).
function regularChromiumPath() {
  const p = chromium.executablePath();
  // Default headless-shell path looks like:
  //   .../ms-playwright/chromium_headless_shell-XXXX/chrome-headless-shell-linux64/chrome-headless-shell
  // Regular chromium path:
  //   .../ms-playwright/chromium-XXXX/chrome-linux64/chrome
  return p
    .replace(/chromium_headless_shell-/g, 'chromium-')
    .replace(/chrome-headless-shell-linux64/g, 'chrome-linux64')
    .replace(/chrome-headless-shell$/, 'chrome');
}

function ensureChromium() {
  try {
    const exePath = regularChromiumPath();
    if (!existsSync(exePath)) {
      console.log(`[fbExtractor] Regular Chromium missing at ${exePath} — installing...`);
      execSync('npx playwright install chromium', { stdio: 'pipe' });
      console.log('[fbExtractor] Chromium installed.');
    } else {
      console.log(`[fbExtractor] Regular Chromium found at ${exePath}`);
    }
  } catch (e) {
    console.warn('[fbExtractor] ensureChromium check failed:', e.message);
  }
}

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  ensureChromium();
  const exePath = regularChromiumPath();
  console.log(`[fbExtractor] Launching warm Chromium at ${exePath}...`);
  const t0 = Date.now();
  _browser = await chromium.launch({
    executablePath: exePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  // Single shared context — realistic viewport + UA, US locale so geo-fenced
  // ads load properly. Persistent across all extractions in this session.
  _browserContext = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  _browser.on('disconnected', () => {
    console.warn('[fbExtractor] Chromium disconnected — will relaunch on next call');
    _browser = null;
    _browserContext = null;
  });
  console.log(`[fbExtractor] Warm browser ready in ${Date.now() - t0}ms`);
  return _browser;
}

// Boot-time warmup so the first import doesn't pay the cold start.
// Fired by the Brief Pipeline router after server boot.
let _warmupStarted = false;
export function warmupBrowser() {
  if (_warmupStarted) return;
  _warmupStarted = true;
  getBrowser().catch((e) => {
    console.warn('[fbExtractor] Boot warmup failed (will retry on first call):', e.message);
    _warmupStarted = false;
  });
}

// ── The actual extraction ─────────────────────────────────────────────────

/**
 * Extract the direct video CDN URL from a Facebook Ad Library URL.
 *
 * Strategy: open the page in a real browser, intercept network responses
 * looking for .mp4 (FB CDN serves video as fbcdn.net/v/*.mp4), return the
 * first one with a non-trivial Content-Length. If no video request fires
 * within 15s, return null (image-only ad or page failed to load).
 *
 * @param {string} adLibraryUrl - e.g. https://www.facebook.com/ads/library/?id=12345
 * @returns {Promise<string|null>} - direct .mp4 CDN URL or null
 */
export async function extractVideoUrlFromAdLibrary(adLibraryUrl) {
  if (!adLibraryUrl || typeof adLibraryUrl !== 'string') return null;
  if (!/facebook\.com\/ads\/library/i.test(adLibraryUrl)) {
    console.warn('[fbExtractor] Rejecting non-Ad-Library URL:', adLibraryUrl.slice(0, 80));
    return null;
  }

  await acquireSlot();
  const tStart = Date.now();
  let page = null;
  try {
    const browser = await getBrowser();
    const ctx = _browserContext;
    if (!ctx) throw new Error('Browser context unavailable');

    page = await ctx.newPage();
    let foundUrl = null;
    const videoCandidates = [];

    // Network listener: capture any .mp4 / .webm / .mov that flies past
    page.on('response', (response) => {
      try {
        const url = response.url();
        // FB video CDN is *.fbcdn.net/v/*.mp4 with query params
        // Also catch .webm just in case
        if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
          videoCandidates.push({
            url,
            status: response.status(),
            contentType: response.headers()['content-type'] || '',
            contentLength: parseInt(response.headers()['content-length'] || '0', 10),
          });
        }
      } catch { /* ignore */ }
    });

    // Block heavy stuff we don't need (images, fonts, stylesheets) — speeds
    // up the page load + reduces RAM. Keep scripts + xhr + media.
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'stylesheet') {
        return route.abort();
      }
      return route.continue();
    });

    // Navigate. Don't wait for full networkidle (FB never goes idle) — settle
    // for domcontentloaded then poll for video URLs.
    await page.goto(adLibraryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 12000,
    });

    // Wait up to 10 seconds for a video URL to surface in the network log
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !foundUrl) {
      // Pick the first candidate that looks like a real video chunk
      const real = videoCandidates.find(v =>
        v.status >= 200 && v.status < 400 &&
        (v.contentLength > 50_000 || v.contentType.includes('video'))
      );
      if (real) {
        foundUrl = real.url;
        break;
      }
      await page.waitForTimeout(300);
    }

    // Fallback: try to extract <video src> directly from DOM
    if (!foundUrl) {
      try {
        foundUrl = await page.evaluate(() => {
          const v = document.querySelector('video[src]');
          return v?.src || null;
        });
      } catch { /* ignore */ }
    }

    const elapsed = Date.now() - tStart;
    if (foundUrl) {
      console.log(`[fbExtractor] Extracted video URL in ${elapsed}ms: ${foundUrl.slice(0, 100)}...`);
    } else {
      console.log(`[fbExtractor] No video URL found after ${elapsed}ms (likely image/carousel ad). Saw ${videoCandidates.length} candidates.`);
    }
    return foundUrl;
  } catch (err) {
    console.error(`[fbExtractor] Extraction error after ${Date.now() - tStart}ms:`, err.message);
    return null;
  } finally {
    try { if (page) await page.close(); } catch { /* ignore */ }
    releaseSlot();
  }
}

/**
 * Shut down the warm browser gracefully. Call on SIGTERM / process exit.
 */
export async function closeBrowser() {
  if (_browser && _browser.isConnected()) {
    try {
      await _browser.close();
      console.log('[fbExtractor] Warm browser closed.');
    } catch (e) {
      console.warn('[fbExtractor] Error closing browser:', e.message);
    }
  }
  _browser = null;
  _browserContext = null;
}
