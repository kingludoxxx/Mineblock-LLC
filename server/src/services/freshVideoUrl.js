// Fresh video URL re-extraction via yt-dlp.
//
// Facebook CDN video URLs carry an `oe=` expiry and die ~2-4 weeks after
// scrape. When a stored URL 403s, the ad may still be live in the FB Ad
// Library — yt-dlp can pull a brand-new (unexpired) fbcdn URL from the
// ad's library page. Used by the League preview player and the
// transcriber as a fallback when the stored URL is dead.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const YTDLP_PATH = join(__dirname, '..', '..', '..', 'bin', 'yt-dlp');

function sanitizeUrlForShell(url) {
  if (!url || typeof url !== 'string') return null;
  if (!/^https?:\/\/[^\s"'`$;|&()<>\\]+$/.test(url)) return null;
  return url;
}

export function adLibraryUrl(adArchiveId) {
  return adArchiveId ? `https://www.facebook.com/ads/library/?id=${String(adArchiveId)}` : null;
}

// Returns a fresh direct video URL for the given page (e.g. an FB Ad
// Library link), or null if extraction fails / yt-dlp is unavailable.
export async function extractFreshVideoUrl(pageUrl) {
  if (!existsSync(YTDLP_PATH)) {
    console.warn('[freshVideoUrl] yt-dlp not available at', YTDLP_PATH);
    return null;
  }
  const safeUrl = sanitizeUrlForShell(pageUrl);
  if (!safeUrl) return null;

  const strategies = [
    ['--get-url', '--no-warnings', '-f', 'best[ext=mp4]/best', safeUrl],
    ['--get-url', '--no-warnings', '-f', 'best', safeUrl],
    ['--get-url', '--no-warnings', '--force-generic-extractor', safeUrl],
  ];
  for (let i = 0; i < strategies.length; i++) {
    try {
      const { stdout } = await execFileAsync(YTDLP_PATH, strategies[i], {
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const firstUrl = stdout.trim().split('\n').find(l => l.startsWith('http'));
      if (firstUrl) {
        console.log(`[freshVideoUrl] strategy ${i + 1} extracted: ${firstUrl.slice(0, 110)}...`);
        return firstUrl;
      }
    } catch (err) {
      console.warn(`[freshVideoUrl] strategy ${i + 1} failed:`, err.message?.slice(0, 160));
    }
  }
  return null;
}
