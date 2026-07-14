/**
 * Brand Spy media mirror.
 *
 * Downloads ad videos, thumbnails, and page profile pictures from Meta's
 * fbcdn (video-*.xx.fbcdn.net / scontent-*.xx.fbcdn.net) and re-uploads them
 * to Cloudflare R2 under stable keys. The URL is stored back in the DB.
 *
 * Why: fbcdn URLs carry an `oe=` expiry and 403 ~2-4 weeks after scrape.
 * R2 URLs never expire — playback stays instant forever.
 *
 * Idempotency: keyed by ad_archive_id / meta_page_id. If the DB row already
 * has an r2 URL, we skip. If the R2 upload succeeds but the DB write fails,
 * the next tick re-uploads (cheap — same key just overwrites).
 */

import { query } from '../config/db.js';
import { uploadBuffer, isR2Configured } from './r2.js';
import { extractFreshVideoUrl, adLibraryUrl } from './freshVideoUrl.js';

const FBCDN_DOWNLOAD_TIMEOUT_MS = 45_000;
// Aggressive caps because the service runs on a 512 MB Render plan and the
// mirror worker OOM'd the process at the original 100 MB × 3-concurrent
// ceiling — 300 MB of in-flight buffers + Node baseline == kill.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;    //  25 MB — most ads are 3-10 MB
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;     //   3 MB — thumbnails are typically < 500 KB

// Meta's edge sometimes wants a plausible User-Agent + Referer or it 403s.
// These headers match what a real Chrome browser sends when loading an
// ad-library preview.
const FBCDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Referer': 'https://www.facebook.com/',
  'Accept': 'video/mp4,image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

async function downloadWithLimit(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FBCDN_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: FBCDN_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`asset ${(buf.length / 1024 / 1024).toFixed(1)} MB exceeds ${maxBytes / 1024 / 1024} MB cap`);
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return { buffer: buf, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mirror a single ad's video + thumbnail to R2.
 * Returns { videoUrlR2, thumbnailUrlR2 } — either may be null if unavailable.
 * Does NOT throw on individual asset failures; logs and returns partial results.
 */
export async function mirrorAdAssets({ adArchiveId, videoUrl, thumbnailUrl }) {
  if (!isR2Configured()) return { videoUrlR2: null, thumbnailUrlR2: null };
  if (!adArchiveId) return { videoUrlR2: null, thumbnailUrlR2: null };

  let videoUrlR2 = null;
  let thumbnailUrlR2 = null;

  // --- Video ---
  if (videoUrl) {
    try {
      let { buffer, contentType } = await downloadWithLimit(videoUrl, MAX_VIDEO_BYTES);
      // fbcdn may have already expired the stored URL. Try yt-dlp re-extract
      // once as a fallback before giving up.
      if (!buffer || buffer.length < 1024) {
        const fresh = await extractFreshVideoUrl(adLibraryUrl(adArchiveId));
        if (fresh) {
          ({ buffer, contentType } = await downloadWithLimit(fresh, MAX_VIDEO_BYTES));
        }
      }
      if (buffer && buffer.length >= 1024) {
        const key = `brand-spy/videos/${adArchiveId}.mp4`;
        videoUrlR2 = await uploadBuffer(buffer, key, contentType || 'video/mp4');
      }
    } catch (err) {
      // Try yt-dlp fallback on any download failure (403, timeout, etc.)
      try {
        const fresh = await extractFreshVideoUrl(adLibraryUrl(adArchiveId));
        if (fresh) {
          const { buffer, contentType } = await downloadWithLimit(fresh, MAX_VIDEO_BYTES);
          if (buffer && buffer.length >= 1024) {
            const key = `brand-spy/videos/${adArchiveId}.mp4`;
            videoUrlR2 = await uploadBuffer(buffer, key, contentType || 'video/mp4');
          }
        }
      } catch (fallbackErr) {
        console.warn(`[bs-mirror] video ${adArchiveId} failed: ${err.message}; fresh-url fallback: ${fallbackErr.message}`);
      }
    }
  }

  // --- Thumbnail ---
  if (thumbnailUrl) {
    try {
      const { buffer, contentType } = await downloadWithLimit(thumbnailUrl, MAX_IMAGE_BYTES);
      if (buffer && buffer.length >= 256) {
        const ext = (contentType || '').includes('png') ? 'png' : 'jpg';
        const key = `brand-spy/thumbs/${adArchiveId}.${ext}`;
        thumbnailUrlR2 = await uploadBuffer(buffer, key, contentType || 'image/jpeg');
      }
    } catch (err) {
      console.warn(`[bs-mirror] thumb ${adArchiveId} failed: ${err.message}`);
    }
  }

  return { videoUrlR2, thumbnailUrlR2 };
}

/**
 * Mirror a single brand page's profile picture to R2.
 * Returns the R2 URL or null.
 */
export async function mirrorPageProfilePic({ metaPageId, pageProfilePic }) {
  if (!isR2Configured() || !metaPageId || !pageProfilePic) return null;
  try {
    const { buffer, contentType } = await downloadWithLimit(pageProfilePic, MAX_IMAGE_BYTES);
    if (!buffer || buffer.length < 256) return null;
    const ext = (contentType || '').includes('png') ? 'png' : 'jpg';
    const key = `brand-spy/pages/${metaPageId}.${ext}`;
    return await uploadBuffer(buffer, key, contentType || 'image/jpeg');
  } catch (err) {
    console.warn(`[bs-mirror] page ${metaPageId} failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background worker — drains the mirror-pending backlog on a timer
// ---------------------------------------------------------------------------

const MIRROR_TICK_MS       = 30 * 1000;   // process a batch every 30s
const MIRROR_BATCH_SIZE    = 4;           // 4 ads per tick — was 8, halved for memory
const MIRROR_CONCURRENCY   = 1;           // serial — starter-plan can't hold 3 × 25 MB buffers

let mirrorRunning = false;

async function mirrorAdsBatch() {
  if (mirrorRunning) return;
  if (!isR2Configured()) return;
  mirrorRunning = true;
  try {
    // Priority: active ads first, oldest scrape first, with any missing asset.
    const { rows } = await query(
      `SELECT id, ad_archive_id, is_active,
              -- Recompute the same URLs we serve to the frontend via SQL
              -- JSON extraction — that's the source of truth for what URL
              -- should get mirrored. Avoids reading the whole raw_snapshot.
              COALESCE(
                a.raw_snapshot->'videos'->0->>'video_hd_url',
                a.raw_snapshot->'videos'->0->>'video_sd_url'
              ) AS video_url,
              COALESCE(
                a.raw_snapshot->'videos'->0->>'video_preview_image_url',
                a.raw_snapshot->'images'->0->>'resized_image_url',
                a.raw_snapshot->'images'->0->>'original_image_url',
                a.raw_snapshot->'cards'->0->>'resized_image_url',
                a.raw_snapshot->'cards'->0->>'original_image_url',
                a.raw_snapshot->>'page_profile_picture_url'
              ) AS thumbnail_url,
              video_url_r2, thumbnail_url_r2
         FROM brand_spy.ads a
        WHERE is_active = TRUE
          AND ((video_url_r2     IS NULL AND (raw_snapshot->'videos'->0 IS NOT NULL))
            OR (thumbnail_url_r2 IS NULL))
        ORDER BY (assets_mirrored_at IS NULL) DESC, assets_mirrored_at ASC
        LIMIT $1`,
      [MIRROR_BATCH_SIZE],
    );
    if (!rows.length) return;

    // Simple concurrency pool
    let idx = 0;
    async function worker() {
      while (idx < rows.length) {
        const row = rows[idx++];
        try {
          const { videoUrlR2, thumbnailUrlR2 } = await mirrorAdAssets({
            adArchiveId: row.ad_archive_id,
            videoUrl: row.video_url_r2 ? null : row.video_url,       // skip if already have R2
            thumbnailUrl: row.thumbnail_url_r2 ? null : row.thumbnail_url,
          });
          await query(
            `UPDATE brand_spy.ads
                SET video_url_r2       = COALESCE($2, video_url_r2),
                    thumbnail_url_r2   = COALESCE($3, thumbnail_url_r2),
                    assets_mirrored_at = NOW()
              WHERE id = $1`,
            [row.id, videoUrlR2, thumbnailUrlR2],
          );
        } catch (err) {
          console.warn(`[bs-mirror] ad ${row.id} tick failed: ${err.message}`);
          // Stamp anyway so we don't hot-loop on a bad row — assets_mirrored_at
          // moves it to the back of the queue on next tick.
          await query(
            `UPDATE brand_spy.ads SET assets_mirrored_at = NOW() WHERE id = $1`,
            [row.id],
          ).catch(() => {});
        }
      }
    }
    await Promise.all(Array.from({ length: MIRROR_CONCURRENCY }, () => worker()));
    console.log(`[bs-mirror] batch complete — processed ${rows.length} ad(s)`);
  } catch (err) {
    console.error('[bs-mirror] tick error:', err.message);
  } finally {
    mirrorRunning = false;
  }
}

async function mirrorPagesBatch() {
  if (!isR2Configured()) return;
  try {
    // Only re-attempt pages we haven't tried in the last hour — 403s on
    // the stored fbcdn URL are permanent for that URL, so hot-looping over
    // the same 8 rows every 30s achieves nothing but log noise. NULLS FIRST
    // takes never-attempted rows before we cycle back to prior failures.
    const { rows } = await query(
      `SELECT id, meta_page_id, page_profile_pic
         FROM brand_spy.brand_pages
        WHERE page_profile_pic IS NOT NULL
          AND page_profile_pic_r2 IS NULL
          AND (page_profile_pic_r2_attempted_at IS NULL
               OR page_profile_pic_r2_attempted_at < NOW() - INTERVAL '1 hour')
        ORDER BY page_profile_pic_r2_attempted_at NULLS FIRST
        LIMIT $1`,
      [MIRROR_BATCH_SIZE],
    );
    if (!rows.length) return;
    for (const row of rows) {
      const url = await mirrorPageProfilePic({
        metaPageId: row.meta_page_id,
        pageProfilePic: row.page_profile_pic,
      });
      await query(
        `UPDATE brand_spy.brand_pages
            SET page_profile_pic_r2              = COALESCE($2, page_profile_pic_r2),
                page_profile_pic_r2_attempted_at = NOW()
          WHERE id = $1`,
        [row.id, url],
      );
    }
    console.log(`[bs-mirror] pages — processed ${rows.length}`);
  } catch (err) {
    console.error('[bs-mirror] pages tick error:', err.message);
  }
}

export function startMediaMirrorWorker() {
  if (!isR2Configured()) {
    console.log('[bs-mirror] R2 not configured — media mirror disabled');
    return;
  }
  console.log(`[bs-mirror] media mirror scheduled (every ${MIRROR_TICK_MS / 1000}s, batch=${MIRROR_BATCH_SIZE}, concurrency=${MIRROR_CONCURRENCY})`);
  // First tick 1 min after boot to let the server settle
  setTimeout(() => {
    mirrorAdsBatch();
    mirrorPagesBatch();
    setInterval(() => { mirrorAdsBatch(); mirrorPagesBatch(); }, MIRROR_TICK_MS);
  }, 60_000);
}
