import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import {
  uploadAdVideo, waitForVideoReady, createAd, createAdSet,
  createFlexibleAdCreative, getDefaultAdAccountId, isMetaAdsConfigured,
  getAdAccounts, getPages, getPixels, getCampaigns, getAdSets,
  getCustomAudiences,
} from '../services/metaAdsApi.js';
import crypto from 'crypto';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────

const safeArr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
};

const safeObj = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return (p && typeof p === 'object') ? p : {}; } catch { return {}; }
  }
  return {};
};

function buildLaunchName(pattern, vars = {}) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaults = {
    date: `${pad(today.getMonth() + 1)}${pad(today.getDate())}`,
    angle: 'General',
    batch: '1',
    num: '01',
    product: 'Product',
    ...vars,
  };
  return pattern.replace(/\{(\w+)\}/g, (_, k) => defaults[k] ?? `{${k}}`);
}

// ── Ensure tables ────────────────────────────────────────────────────────

let tablesPromise = null;
async function ensureTables() {
  if (!tablesPromise) tablesPromise = _createTables().catch(err => { tablesPromise = null; throw err; });
  return tablesPromise;
}
async function _createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS video_ads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      filename TEXT NOT NULL,
      original_name TEXT,
      file_size INTEGER DEFAULT 0,
      duration REAL,
      width INTEGER,
      height INTEGER,
      content_type TEXT DEFAULT 'video/mp4',
      source TEXT DEFAULT 'upload',
      source_url TEXT,
      video_url TEXT,
      thumbnail_url TEXT,
      meta_video_id TEXT,
      meta_video_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'uploaded',
      angle TEXT,
      product_id INTEGER,
      ad_copy JSONB DEFAULT '{}',
      launch_config JSONB DEFAULT '{}',
      tags JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS video_ad_launches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      video_ad_id UUID REFERENCES video_ads(id) ON DELETE CASCADE,
      template_id UUID,
      ad_account_id TEXT,
      meta_campaign_id TEXT,
      meta_adset_id TEXT,
      meta_ad_id TEXT,
      meta_creative_id TEXT,
      meta_video_id TEXT,
      ad_name TEXT,
      adset_name TEXT,
      page_id TEXT,
      page_name TEXT,
      batch_number INTEGER,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      launched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Meta endpoints (reuse from brief pipeline pattern) ───────────────────

router.get('/meta/accounts', authenticate, async (_req, res) => {
  try {
    const accounts = await getAdAccounts();
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/sync/:accountId', authenticate, async (req, res) => {
  try {
    const accountId = req.params.accountId;
    const [pages, pixels, campaigns, audiences] = await Promise.all([
      getPages(accountId).catch(() => []),
      getPixels(accountId).catch(() => []),
      getCampaigns(accountId).catch(() => []),
      getCustomAudiences(accountId).catch(() => []),
    ]);
    res.json({ success: true, data: { pages, pixels, campaigns, audiences } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/adsets/:campaignId', authenticate, async (req, res) => {
  try {
    const adsets = await getAdSets(req.params.campaignId);
    res.json({ success: true, data: adsets });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/configured', authenticate, async (_req, res) => {
  res.json({ success: true, data: { configured: isMetaAdsConfigured() } });
});

// ── Launch templates (reuse from brief pipeline table) ───────────────────

router.get('/launch-templates', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery('SELECT * FROM launch_templates ORDER BY created_at DESC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Video Ads CRUD ───────────────────────────────────────────────────────

// POST /videos — Upload video metadata (actual files come via multipart or URL)
router.post('/videos', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { filename, original_name, file_size, duration, width, height, content_type, source, source_url, video_url, thumbnail_url, angle, product_id, tags } = req.body;
    if (!filename && !video_url) {
      return res.status(400).json({ success: false, error: { message: 'filename or video_url is required' } });
    }

    const id = crypto.randomUUID();
    const row = await pgQuery(
      `INSERT INTO video_ads (id, filename, original_name, file_size, duration, width, height, content_type, source, source_url, video_url, thumbnail_url, angle, product_id, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [id, filename || original_name || 'video.mp4', original_name || filename, file_size || 0, duration || null, width || null, height || null, content_type || 'video/mp4', source || 'upload', source_url || null, video_url || null, thumbnail_url || null, angle || null, product_id || null, JSON.stringify(tags || [])]
    );

    res.json({ success: true, data: row[0] });
  } catch (err) {
    console.error('[VideoAdsLauncher] POST /videos error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /videos/bulk — Bulk create video records
router.post('/videos/bulk', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { videos } = req.body;
    if (!Array.isArray(videos) || !videos.length) {
      return res.status(400).json({ success: false, error: { message: 'videos array is required' } });
    }

    const results = [];
    for (const v of videos) {
      const id = crypto.randomUUID();
      const row = await pgQuery(
        `INSERT INTO video_ads (id, filename, original_name, file_size, duration, width, height, content_type, source, source_url, video_url, thumbnail_url, angle, product_id, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, v.filename || v.original_name || 'video.mp4', v.original_name || v.filename, v.file_size || 0, v.duration || null, v.width || null, v.height || null, v.content_type || 'video/mp4', v.source || 'upload', v.source_url || null, v.video_url || null, v.thumbnail_url || null, v.angle || null, v.product_id || null, JSON.stringify(v.tags || [])]
      );
      results.push(row[0]);
    }

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('[VideoAdsLauncher] POST /videos/bulk error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /videos — List video ads
router.get('/videos', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { status, product_id, source } = req.query;
    let query = 'SELECT * FROM video_ads WHERE 1=1';
    const params = [];
    let idx = 1;

    if (status) { query += ` AND status = $${idx++}`; params.push(status); }
    if (product_id) { query += ` AND product_id = $${idx++}`; params.push(product_id); }
    if (source) { query += ` AND source = $${idx++}`; params.push(source); }

    query += ' ORDER BY created_at DESC LIMIT 200';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /videos/:id — Get single video ad
router.get('/videos/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery('SELECT * FROM video_ads WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Video not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /videos/:id — Update video ad metadata
router.patch('/videos/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { angle, product_id, ad_copy, status, tags, video_url, thumbnail_url } = req.body;
    const sets = [];
    const params = [];
    let idx = 1;

    if (angle !== undefined) { sets.push(`angle = $${idx++}`); params.push(angle); }
    if (product_id !== undefined) { sets.push(`product_id = $${idx++}`); params.push(product_id); }
    if (ad_copy !== undefined) { sets.push(`ad_copy = $${idx++}`); params.push(JSON.stringify(ad_copy)); }
    if (status !== undefined) { sets.push(`status = $${idx++}`); params.push(status); }
    if (tags !== undefined) { sets.push(`tags = $${idx++}`); params.push(JSON.stringify(tags)); }
    if (video_url !== undefined) { sets.push(`video_url = $${idx++}`); params.push(video_url); }
    if (thumbnail_url !== undefined) { sets.push(`thumbnail_url = $${idx++}`); params.push(thumbnail_url); }

    if (!sets.length) return res.status(400).json({ success: false, error: { message: 'No fields to update' } });

    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    const query = `UPDATE video_ads SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`;
    const rows = await pgQuery(query, params);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Video not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /videos/:id — Remove video ad (blocks if launching)
router.delete('/videos/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `DELETE FROM video_ads WHERE id = $1 AND status NOT IN ('launching') RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) {
      // Check if it exists but is launching
      const existing = await pgQuery('SELECT status FROM video_ads WHERE id = $1', [req.params.id]);
      if (existing.length && existing[0].status === 'launching') {
        return res.status(409).json({ success: false, error: { message: 'Cannot delete a video that is currently launching' } });
      }
      return res.status(404).json({ success: false, error: { message: 'Video not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /videos — Bulk delete (skips launching videos)
router.delete('/videos', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: { message: 'ids array is required' } });
    const deleted = await pgQuery(
      `DELETE FROM video_ads WHERE id = ANY($1) AND status NOT IN ('launching') RETURNING id`,
      [ids]
    );
    const skipped = ids.length - deleted.length;
    res.json({ success: true, data: { deleted: deleted.length, skipped } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /videos/retry — Reset failed/launched videos to uploadable state
router.post('/videos/retry', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ success: false, error: { message: 'ids array is required' } });
    }
    const rows = await pgQuery(
      `UPDATE video_ads SET status = 'uploaded', updated_at = NOW()
       WHERE id = ANY($1) AND status IN ('failed', 'launched')
       RETURNING id, status`,
      [ids]
    );
    res.json({ success: true, data: { reset: rows.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Upload video file (multipart) ────────────────────────────────────────

router.post('/upload', authenticate, async (req, res) => {
  try {
    await ensureTables();

    // For now, we accept a video URL and store it as a record
    // Actual file uploads will be handled by the frontend uploading to R2/S3 first
    const { video_url, filename, original_name, file_size, duration, content_type } = req.body;
    if (!video_url) {
      return res.status(400).json({ success: false, error: { message: 'video_url is required' } });
    }

    const id = crypto.randomUUID();
    const row = await pgQuery(
      `INSERT INTO video_ads (id, filename, original_name, file_size, duration, content_type, source, video_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,'upload',$7,'uploaded') RETURNING *`,
      [id, filename || 'video.mp4', original_name || filename || 'video.mp4', file_size || 0, duration || null, content_type || 'video/mp4', video_url]
    );

    res.json({ success: true, data: row[0] });
  } catch (err) {
    console.error('[VideoAdsLauncher] POST /upload error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Frame.io import ──────────────────────────────────────────────────────

router.post('/import-frame', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { frame_url } = req.body;
    if (!frame_url) {
      return res.status(400).json({ success: false, error: { message: 'frame_url is required' } });
    }

    // Extract asset ID from Frame.io URL patterns
    // Patterns: next.frame.io/project/.../asset_id, app.frame.io/...
    const FRAME_TOKEN = process.env.FRAME_IO_TOKEN || '';
    if (!FRAME_TOKEN) {
      return res.status(400).json({ success: false, error: { message: 'Frame.io token not configured (FRAME_IO_TOKEN env var)' } });
    }

    // Parse the Frame.io URL to extract the folder/asset ID
    // Common URL patterns:
    // https://next.frame.io/project/{projectId}/{assetId}
    // https://app.frame.io/presentations/{presentationId}
    // https://app.frame.io/reviews/{reviewLinkId}
    let assetId = null;

    // Validate URL before parsing
    let urlObj;
    try {
      urlObj = new URL(frame_url);
    } catch {
      return res.status(400).json({ success: false, error: { message: 'Invalid URL format. Please provide a valid Frame.io URL.' } });
    }

    const segments = urlObj.pathname.split('/').filter(Boolean);

    // Check for review links — these use a special API
    if (segments.includes('reviews') || segments.includes('presentations')) {
      // For review links, we need to fetch the review link data
      const reviewId = segments[segments.length - 1];
      try {
        const reviewRes = await fetch(`https://api.frame.io/v2/review_links/${reviewId}`, {
          headers: { Authorization: `Bearer ${FRAME_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        });
        if (reviewRes.ok) {
          const reviewData = await reviewRes.json();
          // Review links contain items array or asset_id
          if (reviewData.id) {
            // Fetch items from the review link
            const itemsRes = await fetch(`https://api.frame.io/v2/review_links/${reviewData.id}/items`, {
              headers: { Authorization: `Bearer ${FRAME_TOKEN}` },
              signal: AbortSignal.timeout(15000),
            });
            if (itemsRes.ok) {
              const items = await itemsRes.json();
              const videoItems = (Array.isArray(items) ? items : []).filter(
                item => item.type === 'file' && (item.filetype?.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv)$/i.test(item.name || ''))
              );

              if (!videoItems.length) {
                return res.json({ success: true, data: { videos: [], message: 'No video files found in Frame.io review link' } });
              }

              const videos = [];
              for (const item of videoItems) {
                const id = crypto.randomUUID();
                const row = await pgQuery(
                  `INSERT INTO video_ads (id, filename, original_name, file_size, duration, content_type, source, source_url, video_url, thumbnail_url, status)
                   VALUES ($1,$2,$3,$4,$5,$6,'frame',$7,$8,$9,'uploaded') RETURNING *`,
                  [id, item.name || 'frame_video.mp4', item.name, item.filesize || 0, item.duration || null, item.filetype || 'video/mp4', frame_url, item.original || item.h264_1080_best || null, item.thumb_scrub || item.thumb || null]
                );
                videos.push(row[0]);
              }

              return res.json({ success: true, data: { videos, count: videos.length } });
            }
          }
        }
      } catch (reviewErr) {
        console.warn('[VideoAdsLauncher] Review link fetch failed:', reviewErr.message);
      }
      // Review/presentation links must NOT fall through to asset path
      return res.status(400).json({ success: false, error: { message: 'Could not retrieve videos from Frame.io review/presentation link. Check that the link is valid and the Frame.io token has access.' } });
    }

    // For direct asset/folder URLs — try to get the last segment as asset ID
    if (segments.length >= 2) {
      assetId = segments[segments.length - 1];
    }

    if (!assetId) {
      return res.status(400).json({ success: false, error: { message: 'Could not extract asset ID from Frame.io URL. Supported formats: next.frame.io/project/.../assetId, app.frame.io/reviews/..., app.frame.io/presentations/...' } });
    }

    // Fetch asset data from Frame.io API v2
    const assetRes = await fetch(`https://api.frame.io/v2/assets/${assetId}`, {
      headers: { Authorization: `Bearer ${FRAME_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!assetRes.ok) {
      const errText = await assetRes.text();
      return res.status(assetRes.status === 404 ? 404 : 500).json({
        success: false,
        error: { message: `Frame.io API error ${assetRes.status}: ${errText.slice(0, 200)}` }
      });
    }

    const asset = await assetRes.json();

    // If it's a folder, list children and filter videos (with pagination)
    if (asset.type === 'folder' || asset.type === 'version_stack') {
      let allChildren = [];
      let page = 1;
      const PAGE_SIZE = 100;
      const MAX_PAGES = 10; // Safety limit: 1000 assets max

      while (page <= MAX_PAGES) {
        const childrenRes = await fetch(`https://api.frame.io/v2/assets/${assetId}/children?type=file&page_size=${PAGE_SIZE}&page=${page}`, {
          headers: { Authorization: `Bearer ${FRAME_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        });

        if (!childrenRes.ok) {
          if (page === 1) {
            return res.status(500).json({ success: false, error: { message: 'Failed to list Frame.io folder contents' } });
          }
          break; // Got some pages, stop on error
        }

        const children = await childrenRes.json();
        const items = Array.isArray(children) ? children : [];
        allChildren = allChildren.concat(items);

        if (items.length < PAGE_SIZE) break; // Last page
        page++;
      }

      const videoChildren = allChildren.filter(
        c => c.filetype?.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv)$/i.test(c.name || '')
      );

      if (!videoChildren.length) {
        return res.json({ success: true, data: { videos: [], message: 'No video files found in Frame.io folder' } });
      }

      const videos = [];
      for (const child of videoChildren) {
        const id = crypto.randomUUID();
        const row = await pgQuery(
          `INSERT INTO video_ads (id, filename, original_name, file_size, duration, width, height, content_type, source, source_url, video_url, thumbnail_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'frame',$9,$10,$11,'uploaded') RETURNING *`,
          [id, child.name || 'frame_video.mp4', child.name, child.filesize || 0, child.duration || null, child.width || null, child.height || null, child.filetype || 'video/mp4', frame_url, child.original || child.h264_1080_best || null, child.thumb_scrub || child.thumb || null]
        );
        videos.push(row[0]);
      }

      return res.json({ success: true, data: { videos, count: videos.length } });
    }

    // Single file asset
    if (!asset.filetype?.startsWith('video/') && !/\.(mp4|mov|webm|avi|mkv)$/i.test(asset.name || '')) {
      return res.status(400).json({ success: false, error: { message: `Asset "${asset.name}" is not a video file (type: ${asset.filetype})` } });
    }

    const id = crypto.randomUUID();
    const row = await pgQuery(
      `INSERT INTO video_ads (id, filename, original_name, file_size, duration, width, height, content_type, source, source_url, video_url, thumbnail_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'frame',$9,$10,$11,'uploaded') RETURNING *`,
      [id, asset.name || 'frame_video.mp4', asset.name, asset.filesize || 0, asset.duration || null, asset.width || null, asset.height || null, asset.filetype || 'video/mp4', frame_url, asset.original || asset.h264_1080_best || null, asset.thumb_scrub || asset.thumb || null]
    );

    res.json({ success: true, data: { videos: [row[0]], count: 1 } });
  } catch (err) {
    console.error('[VideoAdsLauncher] POST /import-frame error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Helper: normalize countries from template ──────────────────────────

function normalizeCountries(template) {
  const raw = safeArr(template.countries);
  const codes = raw.map(c => {
    if (typeof c === 'string') return c.trim().toUpperCase();
    if (c && typeof c === 'object') return (c.code || c.id || c.value || '').toString().trim().toUpperCase();
    return '';
  }).filter(c => /^[A-Z]{2}$/.test(c));
  return codes.length ? codes : ['US'];
}

// ── Helper: upload video to Meta + create creative + create ad ─────────

async function launchVideoToAdset({ video, template, adsetId, adsetName, page, adName, adCopy, batchNum, templateId }) {
  const launchId = crypto.randomUUID();

  // Create launch record
  await pgQuery(
    `INSERT INTO video_ad_launches (id, video_ad_id, template_id, ad_account_id, batch_number, status)
     VALUES ($1,$2,$3,$4,$5,'uploading')`,
    [launchId, video.id, templateId, template.ad_account_id, batchNum]
  );

  try {
    // Upload video to Meta (if not already uploaded)
    let metaVideoId = video.meta_video_id;
    if (!metaVideoId) {
      if (!video.video_url) throw new Error(`Video ${video.id} has no video_url — cannot upload to Meta`);
      metaVideoId = await uploadAdVideo(template.ad_account_id, video.video_url, video.original_name || video.filename);

      // Cache meta_video_id immediately (before wait) to prevent orphaned re-uploads on timeout
      await pgQuery('UPDATE video_ads SET meta_video_id = $1, meta_video_status = $2, updated_at = NOW() WHERE id = $3',
        [metaVideoId, 'processing', video.id]);

      // Wait for video to finish processing
      await waitForVideoReady(metaVideoId, 120000);

      // Mark as ready
      await pgQuery('UPDATE video_ads SET meta_video_status = $1, updated_at = NOW() WHERE id = $2',
        ['ready', video.id]);
    }

    // Determine ad copy
    const videoCopy = safeObj(video.ad_copy);
    const globalCopy = safeObj(adCopy);
    const primaryText = globalCopy.primary_text || videoCopy.primary_text || '';
    const headline = globalCopy.headline || videoCopy.headline || 'Shop Now';
    const description = globalCopy.description || videoCopy.description || '';
    const cta = globalCopy.cta || videoCopy.cta || 'SHOP_NOW';
    const link = globalCopy.landing_page_url || template.landing_page_url || 'https://mineblock.com';

    // Create ad creative with video
    const videoData = {
      video_id: metaVideoId,
      message: primaryText,
      title: headline,
      link_description: description,
      call_to_action: {
        type: cta,
        value: { link },
      },
    };
    // Meta requires a thumbnail (image_url) for video ads with CTA links
    if (video.thumbnail_url) videoData.image_url = video.thumbnail_url;

    const creativeBody = {
      access_token: process.env.META_ACCESS_TOKEN,
      name: adName,
      object_story_spec: {
        page_id: page?.id,
        video_data: videoData,
      },
    };

    const cleanUTM = template.utm_parameters?.replace(/^[?&]+/, '');
    if (cleanUTM) creativeBody.url_tags = cleanUTM;

    const creativeRes = await fetch(`https://graph.facebook.com/v21.0/${template.ad_account_id}/adcreatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify(creativeBody),
    });

    if (!creativeRes.ok) {
      const errText = await creativeRes.text();
      throw new Error(`Meta creative error ${creativeRes.status}: ${errText.slice(0, 300)}`);
    }

    const creativeData = await creativeRes.json();
    const metaCreativeId = creativeData.id;

    // Create ad
    const metaAdId = await createAd(template.ad_account_id, {
      name: adName,
      adsetId,
      creativeId: metaCreativeId,
      status: 'PAUSED',
    });

    // Update launch record
    await pgQuery(
      `UPDATE video_ad_launches SET status = 'launched', meta_ad_id = $1, meta_creative_id = $2, meta_video_id = $3, meta_campaign_id = $4, meta_adset_id = $5, ad_name = $6, adset_name = $7, page_id = $8, page_name = $9, launched_at = NOW() WHERE id = $10`,
      [metaAdId, metaCreativeId, metaVideoId, template.campaign_id, adsetId, adName, adsetName, page?.id, page?.name, launchId]
    );

    return { video_id: video.id, status: 'launched', meta_ad_id: metaAdId, meta_video_id: metaVideoId, ad_name: adName, adset_id: adsetId, adset_name: adsetName };
  } catch (err) {
    console.error(`[VideoAdsLauncher] Launch failed for video ${video.id} -> adset ${adsetId}:`, err.message);
    await pgQuery(
      `UPDATE video_ad_launches SET status = 'failed', error_message = $1 WHERE id = $2`,
      [err.message, launchId]
    );
    return { video_id: video.id, status: 'failed', error: err.message, adset_id: adsetId, adset_name: adsetName };
  }
}

// ── Launch video ads to Meta (supports multi-adset) ─────────────────────

router.post('/launch', authenticate, async (req, res) => {
  try {
    await ensureTables();
    if (!isMetaAdsConfigured()) {
      return res.status(400).json({ success: false, error: { message: 'Meta Ads API not configured. Set META_ACCESS_TOKEN and META_AD_ACCOUNT_IDS.' } });
    }

    const { video_ids, template_id, ad_copy, adset_count } = req.body;
    const numAdsets = Math.max(1, Math.min(parseInt(adset_count) || 1, 20)); // 1-20 adsets

    if (!video_ids?.length || !template_id) {
      return res.status(400).json({ success: false, error: { message: 'video_ids and template_id are required' } });
    }

    // Load template
    const templates = await pgQuery('SELECT * FROM launch_templates WHERE id = $1', [template_id]);
    if (!templates.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = templates[0];

    if (!template.campaign_id) {
      return res.status(400).json({ success: false, error: { message: 'Template has no campaign configured' } });
    }

    // Load and lock videos atomically — prevents double-launch
    const videos = await pgQuery(
      `UPDATE video_ads SET status = 'launching', updated_at = NOW()
       WHERE id = ANY($1) AND status IN ('uploaded', 'ready', 'approved')
       AND (video_url IS NOT NULL AND video_url != '' OR meta_video_id IS NOT NULL)
       RETURNING *`,
      [video_ids]
    );
    if (!videos.length) {
      return res.status(400).json({ success: false, error: { message: 'No launchable videos found. Videos must be uploaded/ready/approved and have a video URL or existing Meta video ID.' } });
    }

    const launchableIds = videos.map(v => v.id);

    const dateStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }).replace('/', '');
    const batchNum = Math.floor(Date.now() / 1000) % 10000;

    // Page selection
    const selectedPages = safeArr(template.page_ids).filter(p => p.selected !== false);
    if (!selectedPages.length || !selectedPages[0]?.id) {
      await pgQuery(`UPDATE video_ads SET status = 'ready', updated_at = NOW() WHERE id = ANY($1)`, [launchableIds]);
      return res.status(400).json({ success: false, error: { message: 'No Facebook pages configured in launch template' } });
    }

    const normalizedCountries = normalizeCountries(template);

    // Create all adsets
    const adsets = [];
    for (let a = 0; a < numAdsets; a++) {
      const adsetName = buildLaunchName(template.adset_name_pattern || '{date} - Video Batch {batch}', {
        date: dateStr,
        angle: videos[0]?.angle || 'General',
        batch: batchNum,
        product: '',
        num: numAdsets > 1 ? `${a + 1}` : '01',
      }) + (numAdsets > 1 ? ` #${a + 1}` : '');

      try {
        const adsetId = await createAdSet(template.ad_account_id, {
          name: adsetName,
          campaignId: template.campaign_id,
          dailyBudget: template.daily_budget,
          optimizationGoal: template.optimization_goal,
          bidStrategy: template.bid_strategy,
          targetRoas: template.target_roas,
          pixelId: template.pixel_id,
          conversionEvent: template.conversion_event,
          conversionLocation: template.conversion_location,
          targeting: {
            countries: normalizedCountries,
            age_min: template.age_min,
            age_max: template.age_max,
            gender: template.gender,
            include_audiences: safeArr(template.include_audiences),
            exclude_audiences: safeArr(template.exclude_audiences),
          },
          attributionWindow: template.attribution_window,
          pageId: selectedPages[0]?.id,
          status: template.schedule_enabled && template.schedule_date ? 'ACTIVE' : 'PAUSED',
          startTime: template.schedule_enabled && template.schedule_date
            ? `${template.schedule_date}T${template.schedule_time || '00:00'}:00`
            : undefined,
        });
        adsets.push({ id: adsetId, name: adsetName });
      } catch (err) {
        // If first adset fails, abort everything
        if (a === 0) {
          await pgQuery(`UPDATE video_ads SET status = 'ready', updated_at = NOW() WHERE id = ANY($1)`, [launchableIds]);
          return res.status(500).json({ success: false, error: { message: `Ad set creation failed: ${err.message}` } });
        }
        // If subsequent adset fails, continue with what we have
        console.error(`[VideoAdsLauncher] Adset ${a + 1} creation failed:`, err.message);
      }
    }

    // Launch videos into each adset
    // Use a mutable map to cache meta_video_id across adsets (prevents redundant uploads)
    const metaVideoCache = new Map();
    videos.forEach(v => { if (v.meta_video_id) metaVideoCache.set(v.id, v.meta_video_id); });

    const allResults = [];
    let pageIdx = 0;

    for (const adset of adsets) {
      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        // Patch in cached meta_video_id so second adset skips re-upload
        const videoWithCache = { ...video, meta_video_id: metaVideoCache.get(video.id) || video.meta_video_id };
        const page = selectedPages[pageIdx % selectedPages.length];
        pageIdx++;

        const adName = buildLaunchName(template.ad_name_pattern || '{date} - Video {num}', {
          date: dateStr,
          angle: video.angle || 'General',
          num: i + 1,
          batch: batchNum,
          product: '',
        }) + (adsets.length > 1 ? ` [AS${adsets.indexOf(adset) + 1}]` : '');

        const result = await launchVideoToAdset({
          video: videoWithCache,
          template,
          adsetId: adset.id,
          adsetName: adset.name,
          page,
          adName,
          adCopy: ad_copy,
          batchNum,
          templateId: template_id,
        });

        // Cache the meta_video_id from this launch for next adset
        if (result.meta_video_id) metaVideoCache.set(video.id, result.meta_video_id);

        allResults.push(result);
      }
    }

    // Update video statuses
    const launchedVideoIds = [...new Set(allResults.filter(r => r.status === 'launched').map(r => r.video_id))];
    const failedVideoIds = [...new Set(allResults.filter(r => r.status === 'failed').map(r => r.video_id))];

    // Videos that launched in at least one adset = 'launched'
    if (launchedVideoIds.length) {
      await pgQuery(`UPDATE video_ads SET status = 'launched', updated_at = NOW() WHERE id = ANY($1)`, [launchedVideoIds]);
    }
    // Videos that failed in ALL adsets = 'failed'
    const purelyFailed = failedVideoIds.filter(id => !launchedVideoIds.includes(id));
    if (purelyFailed.length) {
      await pgQuery(`UPDATE video_ads SET status = 'failed', updated_at = NOW() WHERE id = ANY($1)`, [purelyFailed]);
    }
    // Safety: reset any that are still 'launching' (shouldn't happen, but prevents stuck state)
    const processedIds = [...new Set([...launchedVideoIds, ...purelyFailed])];
    const stillLaunching = launchableIds.filter(id => !processedIds.includes(id));
    if (stillLaunching.length) {
      await pgQuery(`UPDATE video_ads SET status = 'ready', updated_at = NOW() WHERE id = ANY($1)`, [stillLaunching]);
    }

    const allLaunched = allResults.every(r => r.status === 'launched');
    res.json({
      success: true,
      data: {
        results: allResults,
        adsets: adsets.map(a => ({ id: a.id, name: a.name })),
        adset_count: adsets.length,
        failed_adsets: numAdsets - adsets.length,
        batch_status: allLaunched ? 'launched' : allResults.some(r => r.status === 'launched') ? 'partial' : 'failed',
      }
    });
  } catch (err) {
    console.error('[VideoAdsLauncher] POST /launch error:', err);
    // CRITICAL: reset any videos stuck in 'launching' from this batch
    if (video_ids?.length) {
      try {
        await pgQuery(
          `UPDATE video_ads SET status = 'ready', updated_at = NOW() WHERE id = ANY($1) AND status = 'launching'`,
          [video_ids]
        );
      } catch (resetErr) {
        console.error('[VideoAdsLauncher] Failed to reset stuck videos:', resetErr.message);
      }
    }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Launch status ────────────────────────────────────────────────────────

router.get('/launches', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { video_ad_id, status, limit: lim } = req.query;
    let query = 'SELECT vl.*, va.filename, va.original_name, va.thumbnail_url as video_thumb FROM video_ad_launches vl LEFT JOIN video_ads va ON va.id = vl.video_ad_id WHERE 1=1';
    const params = [];
    let idx = 1;

    if (video_ad_id) { query += ` AND vl.video_ad_id = $${idx++}`; params.push(video_ad_id); }
    if (status) { query += ` AND vl.status = $${idx++}`; params.push(status); }

    query += ` ORDER BY vl.created_at DESC LIMIT $${idx}`;
    params.push(Math.min(parseInt(lim) || 50, 500));

    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
