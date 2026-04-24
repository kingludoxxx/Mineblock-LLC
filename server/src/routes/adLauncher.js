import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import {
  uploadAdImage, createAdCreative, createAd,
  getDefaultAdAccountId, isMetaAdsConfigured,
} from '../services/metaAdsApi.js';
import crypto from 'crypto';

const router = Router();
router.use(authenticate, requirePermission('ads-launcher', 'access'));

// ── Helpers ──────────────────────────────────────────────────────────────

function safeObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return (p && typeof p === 'object') ? p : {}; } catch { return {}; }
  }
  return {};
}

function defaultStoreUrl() {
  // NB: fallback uses the correct `.co` TLD — `mineblock.com` is NOT our store.
  return process.env.SHOPIFY_STORE_URL || 'https://mineblock.co';
}

// Resolve the landing page URL for an ad, in priority order:
// 1. Explicit per-launch override (body.landing_page_url)
// 2. product_profiles.product_url for batch.product_id
// 3. SHOPIFY_STORE_URL env var
// 4. hardcoded https://mineblock.co
async function resolveLandingUrl({ batch, override }) {
  if (override) return override;
  try {
    const rows = await pgQuery(
      'SELECT product_url FROM product_profiles WHERE id = $1',
      [batch.product_id]
    );
    const productUrl = rows[0]?.product_url;
    if (productUrl && typeof productUrl === 'string' && productUrl.trim()) {
      return productUrl.trim();
    }
  } catch (err) {
    // product_profiles may not exist in this environment — fall through.
    console.warn('[AdLauncher] resolveLandingUrl: could not read product_profiles:', err.message);
  }
  return defaultStoreUrl();
}

// ── Schema bootstrap ─────────────────────────────────────────────────────
// The authoritative schema lives in migration 022_create_ad_batches_launches.sql
// (with CHECK constraints + FK cascades). ensureTables() is a safety net for
// environments where migrations haven't run — it matches the migration shape.
let tablesPromise = null;
async function ensureTables() {
  if (!tablesPromise) tablesPromise = _createTables().catch(err => { tablesPromise = null; throw err; });
  return tablesPromise;
}
async function _createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ad_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER NOT NULL,
      pipeline TEXT NOT NULL DEFAULT 'standard',
      name TEXT,
      angle TEXT,
      batch_size INTEGER DEFAULT 6,
      status TEXT DEFAULT 'assembling',
      meta_campaign_id TEXT,
      meta_adset_id TEXT,
      launch_config JSONB DEFAULT '{}',
      launched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ad_launches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID,
      creative_id UUID,
      copy_id UUID,
      meta_ad_id TEXT,
      meta_creative_id TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      launched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Routes ───────────────────────────────────────────────────────────────
// NOTE: authenticate + requirePermission are applied router-wide via
// router.use() above. Per-route middleware is intentionally NOT duplicated.

// POST /batches — Create batch from approved creatives
router.post('/batches', async (req, res) => {
  try {
    await ensureTables();
    const { product_id, pipeline, creative_ids, angle, name } = req.body;
    if (!product_id || !pipeline || !creative_ids?.length) {
      return res.status(400).json({ success: false, error: { message: 'product_id, pipeline, and creative_ids are required' } });
    }

    const batchId = crypto.randomUUID();
    const batchName = name || `${angle || 'Batch'} - ${new Date().toLocaleDateString()}`;

    // Insert batch first. If any creative update fails below, we roll back by
    // deleting the batch row (cheaper than a full transaction given pool churn).
    const batch = await pgQuery(
      `INSERT INTO ad_batches (id, product_id, pipeline, name, angle, batch_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'assembling')
       RETURNING *`,
      [batchId, product_id, pipeline, batchName, angle || null, creative_ids.length]
    );

    try {
      for (let i = 0; i < creative_ids.length; i++) {
        await pgQuery(
          'UPDATE spy_creatives SET batch_id = $1, batch_position = $2, status = $3, updated_at = NOW() WHERE id = $4',
          [batchId, i + 1, 'queued', creative_ids[i]]
        );
      }
      await pgQuery("UPDATE ad_batches SET status = 'ready', updated_at = NOW() WHERE id = $1", [batchId]);
    } catch (err) {
      // Rollback: un-queue any creatives we managed to update, then drop batch.
      await pgQuery(
        "UPDATE spy_creatives SET batch_id = NULL, batch_position = NULL, status = 'approved' WHERE batch_id = $1",
        [batchId]
      ).catch(() => {});
      await pgQuery('DELETE FROM ad_batches WHERE id = $1', [batchId]).catch(() => {});
      throw err;
    }

    const creatives = await pgQuery('SELECT * FROM spy_creatives WHERE batch_id = $1 ORDER BY batch_position', [batchId]);
    res.json({ success: true, data: { batch: batch[0], creatives } });
  } catch (err) {
    console.error('[AdLauncher] POST /batches error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /batches — List batches
router.get('/batches', async (req, res) => {
  try {
    await ensureTables();
    const { product_id, status, pipeline } = req.query;
    let query = 'SELECT b.*, COUNT(c.id) as creative_count FROM ad_batches b LEFT JOIN spy_creatives c ON c.batch_id = b.id WHERE 1=1';
    const params = [];
    let idx = 1;

    if (product_id) { query += ` AND b.product_id = $${idx++}`; params.push(product_id); }
    if (status) { query += ` AND b.status = $${idx++}`; params.push(status); }
    if (pipeline) { query += ` AND b.pipeline = $${idx++}`; params.push(pipeline); }

    query += ' GROUP BY b.id ORDER BY b.created_at DESC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[AdLauncher] GET /batches error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /batches/:id — Get batch with creatives
router.get('/batches/:id', async (req, res) => {
  try {
    await ensureTables();
    const batches = await pgQuery('SELECT * FROM ad_batches WHERE id = $1', [req.params.id]);
    if (batches.length === 0) return res.status(404).json({ success: false, error: { message: 'Batch not found' } });
    const creatives = await pgQuery('SELECT * FROM spy_creatives WHERE batch_id = $1 ORDER BY batch_position', [req.params.id]);
    res.json({ success: true, data: { batch: batches[0], creatives } });
  } catch (err) {
    console.error('[AdLauncher] GET /batches/:id error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /batches/:id — Delete batch, un-queue creatives
router.delete('/batches/:id', async (req, res) => {
  try {
    await ensureTables();
    await pgQuery("UPDATE spy_creatives SET batch_id = NULL, batch_position = NULL, status = 'approved', updated_at = NOW() WHERE batch_id = $1", [req.params.id]);
    await pgQuery('DELETE FROM ad_launches WHERE batch_id = $1', [req.params.id]);
    const rows = await pgQuery('DELETE FROM ad_batches WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Batch not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('[AdLauncher] DELETE /batches/:id error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /auto-assemble — Auto-group approved creatives by angle into batches
// Prior version had a meaningless `/batches/:id/auto-assemble` path where :id was
// silently ignored. The canonical path is now POST /auto-assemble with product_id
// in the body. The old path is kept as an alias that forwards.
async function autoAssembleHandler(req, res) {
  try {
    await ensureTables();
    const { product_id, pipeline = 'standard', batch_size = 6 } = req.body;
    if (!product_id) return res.status(400).json({ success: false, error: { message: 'product_id is required' } });

    const creatives = await pgQuery(
      "SELECT * FROM spy_creatives WHERE product_id = $1 AND pipeline = $2 AND status = 'approved' AND batch_id IS NULL ORDER BY angle, created_at",
      [product_id, pipeline]
    );

    if (creatives.length === 0) {
      return res.json({ success: true, data: { batches: [], message: 'No approved creatives to batch' } });
    }

    const byAngle = {};
    for (const c of creatives) {
      const angle = c.angle || 'General';
      if (!byAngle[angle]) byAngle[angle] = [];
      byAngle[angle].push(c);
    }

    const batches = [];
    for (const [angle, angleCreatives] of Object.entries(byAngle)) {
      for (let i = 0; i < angleCreatives.length; i += batch_size) {
        const chunk = angleCreatives.slice(i, i + batch_size);
        const batchNum = Math.floor(i / batch_size) + 1;
        const batchId = crypto.randomUUID();

        await pgQuery(
          `INSERT INTO ad_batches (id, product_id, pipeline, name, angle, batch_size, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'ready')`,
          [batchId, product_id, pipeline, `${angle} ${batchNum}`, angle, chunk.length]
        );

        for (let j = 0; j < chunk.length; j++) {
          await pgQuery(
            "UPDATE spy_creatives SET batch_id = $1, batch_position = $2, status = 'queued', updated_at = NOW() WHERE id = $3",
            [batchId, j + 1, chunk[j].id]
          );
        }

        batches.push({ id: batchId, angle, name: `${angle} ${batchNum}`, count: chunk.length });
      }
    }

    res.json({ success: true, data: { batches } });
  } catch (err) {
    console.error('[AdLauncher] /auto-assemble error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
}

router.post('/auto-assemble', autoAssembleHandler);
// Backward-compat alias (the old route where :id was unused)
router.post('/batches/:id/auto-assemble', autoAssembleHandler);

// POST /batches/:id/launch — Launch batch to Meta
// Body:
//   adset_id          (required)    — Meta ad set to launch into
//   campaign_id       (optional)    — stored on batch for audit
//   page_id           (required*)   — Facebook page to run the ads from.
//                                     *Required unless META_PAGE_ID env var is set.
//   instagram_actor_id(optional)    — IG business account id, for IG placements
//   cta               (optional)    — Meta CTA enum, defaults SHOP_NOW
//   landing_page_url  (optional)    — overrides product_profiles.product_url
//   status            (optional)    — ACTIVE | PAUSED (default ACTIVE)
router.post('/batches/:id/launch', async (req, res) => {
  try {
    await ensureTables();
    if (!isMetaAdsConfigured()) {
      return res.status(400).json({ success: false, error: { message: 'Meta Ads API not configured. Set META_ACCESS_TOKEN and META_AD_ACCOUNT_IDS.' } });
    }

    const {
      adset_id, campaign_id, page_id, instagram_actor_id,
      cta = 'SHOP_NOW', landing_page_url, status: adStatus = 'ACTIVE',
    } = req.body;

    if (!adset_id) {
      return res.status(400).json({ success: false, error: { message: 'adset_id is required' } });
    }
    if (!page_id && !process.env.META_PAGE_ID) {
      return res.status(400).json({ success: false, error: { message: 'page_id is required (or set META_PAGE_ID env var)' } });
    }

    const batches = await pgQuery('SELECT * FROM ad_batches WHERE id = $1', [req.params.id]);
    if (batches.length === 0) return res.status(404).json({ success: false, error: { message: 'Batch not found' } });
    const batch = batches[0];

    const creatives = await pgQuery('SELECT * FROM spy_creatives WHERE batch_id = $1 ORDER BY batch_position', [req.params.id]);
    if (creatives.length === 0) return res.status(400).json({ success: false, error: { message: 'No creatives in batch' } });

    const landingUrl = await resolveLandingUrl({ batch, override: landing_page_url });

    await pgQuery(
      "UPDATE ad_batches SET status = 'launching', meta_adset_id = $1, meta_campaign_id = $2, updated_at = NOW() WHERE id = $3",
      [adset_id, campaign_id || null, req.params.id]
    );

    const adAccountId = getDefaultAdAccountId();
    const results = [];

    for (const creative of creatives) {
      const launchId = crypto.randomUUID();
      let launchInserted = false;
      try {
        await pgQuery(
          "INSERT INTO ad_launches (id, batch_id, creative_id, copy_id, status) VALUES ($1, $2, $3, $4, 'uploading')",
          [launchId, batch.id, creative.id, creative.advertorial_copy_id || null]
        );
        launchInserted = true;

        // Download the creative image and upload to Meta
        const imageRes = await fetch(creative.image_url);
        if (!imageRes.ok) throw new Error(`Failed to download creative image (${imageRes.status})`);
        const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
        const { hash } = await uploadAdImage(adAccountId, imageBuffer);

        // Resolve copy from adapted_text (preferred) or claude_analysis (legacy)
        const adapted = safeObj(creative.adapted_text);
        const legacy = safeObj(creative.claude_analysis).adapted_text
          ? safeObj(safeObj(creative.claude_analysis).adapted_text)
          : {};

        const primaryText =
          adapted.body || legacy.body ||
          adapted.primary_text || legacy.primary_text || '';
        const headlineText = adapted.headline || legacy.headline || '';
        const descriptionText = adapted.subheadline || adapted.description || legacy.subheadline || '';

        const metaCreativeId = await createAdCreative(adAccountId, {
          name: `${batch.name} - ${creative.batch_position}`,
          imageHashes: [hash],
          primaryText,
          headlines: headlineText ? [headlineText] : [],
          descriptions: descriptionText ? [descriptionText] : [],
          cta,
          link: landingUrl,
          pageId: page_id,
          instagramActorId: instagram_actor_id,
        });

        const metaAdId = await createAd(adAccountId, {
          name: `${batch.name} - ${creative.batch_position}`,
          adsetId: adset_id,
          creativeId: metaCreativeId,
          status: adStatus,
        });

        await pgQuery(
          "UPDATE ad_launches SET status = 'launched', meta_ad_id = $1, meta_creative_id = $2, launched_at = NOW() WHERE id = $3",
          [metaAdId, metaCreativeId, launchId]
        );
        await pgQuery("UPDATE spy_creatives SET status = 'launched', updated_at = NOW() WHERE id = $1", [creative.id]);

        results.push({ creative_id: creative.id, status: 'launched', meta_ad_id: metaAdId });
      } catch (err) {
        console.error(`[AdLauncher] Launch failed for creative ${creative.id}:`, err.message);
        if (launchInserted) {
          await pgQuery(
            "UPDATE ad_launches SET status = 'failed', error_message = $1 WHERE id = $2",
            [err.message, launchId]
          ).catch(() => {});
        }
        results.push({ creative_id: creative.id, status: 'failed', error: err.message });
      }
    }

    const allLaunched = results.every(r => r.status === 'launched');
    const anyLaunched = results.some(r => r.status === 'launched');
    await pgQuery(
      `UPDATE ad_batches SET status = $1, launched_at = $2, updated_at = NOW() WHERE id = $3`,
      [
        allLaunched ? 'launched' : (anyLaunched ? 'launched' : 'failed'),
        allLaunched || anyLaunched ? new Date().toISOString() : null,
        req.params.id,
      ]
    );

    res.json({
      success: true,
      data: {
        results,
        batch_status: allLaunched ? 'launched' : (anyLaunched ? 'partial' : 'failed'),
        landing_url: landingUrl,
      },
    });
  } catch (err) {
    console.error('[AdLauncher] POST /launch error:', err);
    // Reset batch status so it isn't stuck on 'launching'
    try {
      await pgQuery(
        "UPDATE ad_batches SET status = 'ready', updated_at = NOW() WHERE id = $1 AND status = 'launching'",
        [req.params.id]
      );
    } catch (_) { /* ignore */ }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /batches/:id/launch-status
router.get('/batches/:id/launch-status', async (req, res) => {
  try {
    await ensureTables();
    const launches = await pgQuery('SELECT * FROM ad_launches WHERE batch_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ success: true, data: launches });
  } catch (err) {
    console.error('[AdLauncher] GET /launch-status error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
