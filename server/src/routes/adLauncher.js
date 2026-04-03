import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import { uploadAdImage, createAdCreative, createAd, getDefaultAdAccountId, isMetaAdsConfigured } from '../services/metaAdsApi.js';
import crypto from 'crypto';

const router = Router();

let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
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
  tablesReady = true;
}

// POST /batches — Create batch from approved creatives
router.post('/batches', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { product_id, pipeline, creative_ids, angle, name } = req.body;
    if (!product_id || !pipeline || !creative_ids?.length) {
      return res.status(400).json({ success: false, error: { message: 'product_id, pipeline, and creative_ids are required' } });
    }

    const batchId = crypto.randomUUID();
    const batchName = name || `${angle || 'Batch'} - ${new Date().toLocaleDateString()}`;

    const batch = await pgQuery(
      `INSERT INTO ad_batches (id, product_id, pipeline, name, angle, batch_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'assembling')
       RETURNING *`,
      [batchId, product_id, pipeline, batchName, angle || null, creative_ids.length]
    );

    // Update creatives to belong to this batch
    for (let i = 0; i < creative_ids.length; i++) {
      await pgQuery(
        'UPDATE spy_creatives SET batch_id = $1, batch_position = $2, status = $3, updated_at = NOW() WHERE id = $4',
        [batchId, i + 1, 'queued', creative_ids[i]]
      );
    }

    // Mark batch as ready
    await pgQuery("UPDATE ad_batches SET status = 'ready', updated_at = NOW() WHERE id = $1", [batchId]);

    const creatives = await pgQuery('SELECT * FROM spy_creatives WHERE batch_id = $1 ORDER BY batch_position', [batchId]);

    res.json({ success: true, data: { batch: batch[0], creatives } });
  } catch (err) {
    console.error('[AdLauncher] /batches error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /batches — List batches
router.get('/batches', authenticate, async (req, res) => {
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
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /batches/:id — Get batch with creatives
router.get('/batches/:id', authenticate, async (req, res) => {
  try {
    const batches = await pgQuery('SELECT * FROM ad_batches WHERE id = $1', [req.params.id]);
    if (batches.length === 0) return res.status(404).json({ success: false, error: { message: 'Batch not found' } });
    const creatives = await pgQuery('SELECT * FROM spy_creatives WHERE batch_id = $1 ORDER BY batch_position', [req.params.id]);
    res.json({ success: true, data: { batch: batches[0], creatives } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /batches/:id — Delete batch, un-queue creatives
router.delete('/batches/:id', authenticate, async (req, res) => {
  try {
    await pgQuery("UPDATE spy_creatives SET batch_id = NULL, batch_position = NULL, status = 'approved', updated_at = NOW() WHERE batch_id = $1", [req.params.id]);
    await pgQuery('DELETE FROM ad_launches WHERE batch_id = $1', [req.params.id]);
    const rows = await pgQuery('DELETE FROM ad_batches WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Batch not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /batches/:id/auto-assemble — Auto-group by angle into batches of 6
router.post('/batches/:id/auto-assemble', authenticate, async (req, res) => {
  // Note: the :id here is actually the product_id (for semantic clarity, use a body param instead)
  try {
    const { product_id, pipeline = 'standard', batch_size = 6 } = req.body;
    if (!product_id) return res.status(400).json({ success: false, error: { message: 'product_id is required' } });

    // Get approved creatives not in any batch
    const creatives = await pgQuery(
      "SELECT * FROM spy_creatives WHERE product_id = $1 AND pipeline = $2 AND status = 'approved' AND batch_id IS NULL ORDER BY angle, created_at",
      [product_id, pipeline]
    );

    if (creatives.length === 0) {
      return res.json({ success: true, data: { batches: [], message: 'No approved creatives to batch' } });
    }

    // Group by angle
    const byAngle = {};
    for (const c of creatives) {
      const angle = c.angle || 'General';
      if (!byAngle[angle]) byAngle[angle] = [];
      byAngle[angle].push(c);
    }

    const batches = [];
    for (const [angle, angleCreatives] of Object.entries(byAngle)) {
      // Chunk into batches
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
});

// POST /batches/:id/launch — Launch batch to Meta
router.post('/batches/:id/launch', authenticate, async (req, res) => {
  try {
    if (!isMetaAdsConfigured()) {
      return res.status(400).json({ success: false, error: { message: 'Meta Ads API not configured. Set META_ACCESS_TOKEN and META_AD_ACCOUNT_IDS.' } });
    }

    const { adset_id, campaign_id, status: adStatus = 'PAUSED' } = req.body;
    if (!adset_id) return res.status(400).json({ success: false, error: { message: 'adset_id is required' } });

    const batches = await pgQuery('SELECT * FROM ad_batches WHERE id = $1', [req.params.id]);
    if (batches.length === 0) return res.status(404).json({ success: false, error: { message: 'Batch not found' } });
    const batch = batches[0];

    const creatives = await pgQuery('SELECT * FROM spy_creatives WHERE batch_id = $1 ORDER BY batch_position', [req.params.id]);
    if (creatives.length === 0) return res.status(400).json({ success: false, error: { message: 'No creatives in batch' } });

    await pgQuery("UPDATE ad_batches SET status = 'launching', meta_adset_id = $1, meta_campaign_id = $2, updated_at = NOW() WHERE id = $3",
      [adset_id, campaign_id || null, req.params.id]);

    const adAccountId = getDefaultAdAccountId();
    const results = [];

    for (const creative of creatives) {
      const launchId = crypto.randomUUID();
      try {
        // Create launch record
        await pgQuery(
          "INSERT INTO ad_launches (id, batch_id, creative_id, status) VALUES ($1, $2, $3, 'uploading')",
          [launchId, batch.id, creative.id]
        );

        // Download image and upload to Meta
        const imageRes = await fetch(creative.image_url);
        if (!imageRes.ok) throw new Error(`Failed to download creative image: ${imageRes.status}`);
        const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

        const { hash } = await uploadAdImage(adAccountId, imageBuffer);

        // Create ad creative on Meta
        const metaCreativeId = await createAdCreative(adAccountId, {
          name: `${batch.name} - ${creative.batch_position}`,
          imageHashes: [hash],
          primaryText: creative.adapted_text?.body || creative.claude_analysis?.adapted_text?.body || '',
          headlines: creative.adapted_text?.headline ? [creative.adapted_text.headline] : ['Shop Now'],
          descriptions: creative.adapted_text?.subheadline ? [creative.adapted_text.subheadline] : [''],
          link: process.env.SHOPIFY_STORE_URL || 'https://mineblock.com',
        });

        // Create ad
        const metaAdId = await createAd(adAccountId, {
          name: `${batch.name} - ${creative.batch_position}`,
          adsetId: adset_id,
          creativeId: metaCreativeId,
          status: adStatus,
        });

        // Update records
        await pgQuery(
          "UPDATE ad_launches SET status = 'launched', meta_ad_id = $1, meta_creative_id = $2, launched_at = NOW() WHERE id = $3",
          [metaAdId, metaCreativeId, launchId]
        );
        await pgQuery("UPDATE spy_creatives SET status = 'launched', updated_at = NOW() WHERE id = $1", [creative.id]);

        results.push({ creative_id: creative.id, status: 'launched', meta_ad_id: metaAdId });
      } catch (err) {
        await pgQuery("UPDATE ad_launches SET status = 'failed', error_message = $1 WHERE id = $2", [err.message, launchId]);
        results.push({ creative_id: creative.id, status: 'failed', error: err.message });
      }
    }

    const allLaunched = results.every(r => r.status === 'launched');
    await pgQuery(
      `UPDATE ad_batches SET status = $1, launched_at = $2, updated_at = NOW() WHERE id = $3`,
      [allLaunched ? 'launched' : 'failed', allLaunched ? new Date().toISOString() : null, req.params.id]
    );

    res.json({ success: true, data: { results, batch_status: allLaunched ? 'launched' : 'partial' } });
  } catch (err) {
    console.error('[AdLauncher] /launch error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /batches/:id/launch-status
router.get('/batches/:id/launch-status', authenticate, async (req, res) => {
  try {
    const launches = await pgQuery('SELECT * FROM ad_launches WHERE batch_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ success: true, data: launches });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
