import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildCopySystemPrompt,
  buildCopyAdaptPrompt,
  buildInlineEditPrompt,
  buildArchetypeClassifyPrompt,
  buildConceptNamePrompt,
} from '../utils/advertorialPrompts.js';
import { generateImage, generateImages } from '../services/geminiImageGen.js';
import { ARCHETYPES, buildClassificationPrompt, buildConceptPrompt, buildGeminiPrompt, validatePrompt } from '../utils/archetypePrompts.js';
import { uploadBuffer, uploadFromUrl, isR2Configured } from '../services/r2.js';
import crypto from 'crypto';

const router = Router();
const anthropic = new Anthropic();

// ── Ensure tables exist ──────────────────────────────────────────────
let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS advertorial_copies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER NOT NULL,
      title TEXT,
      concept_name TEXT,
      ad_copy TEXT NOT NULL,
      ad_copy_word_count INTEGER,
      original_copy TEXT,
      source_type TEXT DEFAULT 'competitor',
      source_brand_name TEXT,
      angle TEXT,
      adaptation_type TEXT,
      headlines JSONB DEFAULT '[]',
      descriptions JSONB DEFAULT '[]',
      compliance_score INTEGER,
      compliance_notes TEXT,
      archetype TEXT,
      secondary_archetype TEXT,
      image_concepts JSONB DEFAULT '[]',
      images JSONB DEFAULT '[]',
      image_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'draft',
      group_id UUID,
      group_name TEXT,
      batch_number INTEGER,
      generation INTEGER DEFAULT 1,
      parent_copy_id UUID,
      rewrite_prompt TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS spy_creatives (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER NOT NULL,
      pipeline TEXT NOT NULL DEFAULT 'standard',
      reference_image_id UUID,
      advertorial_copy_id UUID,
      image_url TEXT,
      r2_key TEXT,
      thumbnail_url TEXT,
      source_label TEXT,
      claude_analysis JSONB,
      adapted_text JSONB,
      swap_pairs JSONB,
      generation_prompt TEXT,
      generation_provider TEXT DEFAULT 'nanobanana',
      generation_model TEXT,
      generation_task_id TEXT,
      angle TEXT,
      archetype TEXT,
      aspect_ratio TEXT DEFAULT '4:5',
      group_id UUID,
      parent_creative_id UUID,
      generation INTEGER DEFAULT 1,
      status TEXT DEFAULT 'review',
      batch_id UUID,
      batch_position INTEGER,
      review_notes TEXT,
      is_organic BOOLEAN DEFAULT false,
      feedback_action TEXT,
      feedback_reason TEXT,
      feedback_tags JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS organic_images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      image_url TEXT NOT NULL,
      r2_key TEXT,
      source TEXT NOT NULL DEFAULT 'reddit',
      source_url TEXT,
      title TEXT,
      description TEXT,
      subreddit TEXT,
      board TEXT,
      author TEXT,
      upvotes INTEGER DEFAULT 0,
      tags JSONB DEFAULT '[]',
      tag_source TEXT DEFAULT 'auto',
      organic_score NUMERIC,
      usage_count INTEGER DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      status TEXT DEFAULT 'active',
      product_id INTEGER,
      match_score NUMERIC,
      keyword_weight NUMERIC,
      scrape_keyword TEXT,
      scrape_job_id UUID,
      is_rejected BOOLEAN DEFAULT false,
      rejection_reason TEXT,
      rejected_by TEXT,
      vision_data JSONB,
      highlighted BOOLEAN DEFAULT false,
      highlight_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS image_scrape_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform TEXT NOT NULL DEFAULT 'reddit',
      keyword TEXT,
      subreddit TEXT,
      status TEXT DEFAULT 'pending',
      images_found INTEGER DEFAULT 0,
      images_saved INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  tablesReady = true;
}

// POST /copies/generate — Generate 3 copy variants from source copy
router.post('/copies/generate', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { product_id, source_copy, angle, custom_instructions } = req.body;
    if (!product_id || !source_copy || !angle) {
      return res.status(400).json({ success: false, error: { message: 'product_id, source_copy, and angle are required' } });
    }

    // Load product profile
    const products = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [product_id]);
    if (products.length === 0) return res.status(404).json({ success: false, error: { message: 'Product not found' } });
    const product = products[0];

    const adaptationTypes = ['direct_adapt', 'pain_pivot', 'creative_swing'];
    const groupId = crypto.randomUUID();
    const systemPrompt = buildCopySystemPrompt();

    // Generate all 3 in parallel
    const results = await Promise.allSettled(
      adaptationTypes.map(async (type) => {
        const userPrompt = buildCopyAdaptPrompt(source_copy, product, angle, type);
        const finalPrompt = custom_instructions ? `${userPrompt}\n\nADDITIONAL INSTRUCTIONS:\n${custom_instructions}` : userPrompt;

        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 16384,
          system: systemPrompt,
          messages: [{ role: 'user', content: finalPrompt }],
        });

        const text = response.content?.[0]?.text || '';

        // Parse XML response
        const title = text.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || `${angle} - ${type}`;
        const adCopy = text.match(/<adcopy>([\s\S]*?)<\/adcopy>/)?.[1]?.trim() || text;
        const headlinesMatch = text.match(/<headlines>([\s\S]*?)<\/headlines>/)?.[1]?.trim();
        const descriptionsMatch = text.match(/<descriptions>([\s\S]*?)<\/descriptions>/)?.[1]?.trim();
        const complianceScore = parseInt(text.match(/<compliance_score>(\d+)<\/compliance_score>/)?.[1] || '0');
        const complianceNotes = text.match(/<compliance_notes>([\s\S]*?)<\/compliance_notes>/)?.[1]?.trim() || '';

        let headlines = [];
        let descriptions = [];
        try { headlines = JSON.parse(headlinesMatch || '[]'); } catch {}
        try { descriptions = JSON.parse(descriptionsMatch || '[]'); } catch {}

        // Generate concept name
        const conceptResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          messages: [{ role: 'user', content: buildConceptNamePrompt(product.name, angle) }],
        });
        const conceptName = conceptResponse.content?.[0]?.text?.trim() || `${angle} ${type}`;

        const wordCount = adCopy.split(/\s+/).filter(Boolean).length;

        // Insert into DB
        const rows = await pgQuery(
          `INSERT INTO advertorial_copies (product_id, title, concept_name, ad_copy, ad_copy_word_count, original_copy, source_type, angle, adaptation_type, headlines, descriptions, compliance_score, compliance_notes, group_id, group_name, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'copy_review')
           RETURNING *`,
          [product_id, title, conceptName, adCopy, wordCount, source_copy, 'competitor', angle, type, JSON.stringify(headlines), JSON.stringify(descriptions), complianceScore, complianceNotes, groupId, `${angle} 1`]
        );

        return rows[0];
      })
    );

    const copies = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason.message);

    res.json({ success: true, data: { copies, errors } });
  } catch (err) {
    console.error('[Advertorial] /copies/generate error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /copies — List copies with filters
router.get('/copies', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { product_id, status, angle } = req.query;
    let query = 'SELECT * FROM advertorial_copies WHERE 1=1';
    const params = [];
    let idx = 1;

    if (product_id) { query += ` AND product_id = $${idx++}`; params.push(product_id); }
    if (status) { query += ` AND status = $${idx++}`; params.push(status); }
    if (angle) { query += ` AND angle = $${idx++}`; params.push(angle); }

    query += ' ORDER BY created_at DESC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[Advertorial] /copies error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /copies/:id — Get single copy
router.get('/copies/:id', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('SELECT * FROM advertorial_copies WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /copies/:id — Update copy text
router.patch('/copies/:id', authenticate, async (req, res) => {
  try {
    const { ad_copy, title, headlines, descriptions } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;

    if (ad_copy !== undefined) { sets.push(`ad_copy = $${idx++}`); params.push(ad_copy); sets.push(`ad_copy_word_count = $${idx++}`); params.push(ad_copy.split(/\s+/).filter(Boolean).length); }
    if (title !== undefined) { sets.push(`title = $${idx++}`); params.push(title); }
    if (headlines !== undefined) { sets.push(`headlines = $${idx++}`); params.push(JSON.stringify(headlines)); }
    if (descriptions !== undefined) { sets.push(`descriptions = $${idx++}`); params.push(JSON.stringify(descriptions)); }

    params.push(req.params.id);
    const rows = await pgQuery(`UPDATE advertorial_copies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /copies/:id/status — Move copy status
router.patch('/copies/:id/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['draft', 'copy_review', 'copy_approved', 'images_pending', 'images_review', 'ready', 'queued', 'launched', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` } });
    }
    const rows = await pgQuery('UPDATE advertorial_copies SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /copies/:id
router.delete('/copies/:id', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('DELETE FROM advertorial_copies WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /copies/:id/ai-edit — Inline AI editing
router.post('/copies/:id/ai-edit', authenticate, async (req, res) => {
  try {
    const { instruction } = req.body;
    if (!instruction) return res.status(400).json({ success: false, error: { message: 'instruction is required' } });

    const rows = await pgQuery('SELECT * FROM advertorial_copies WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    const copy = rows[0];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      system: buildCopySystemPrompt(),
      messages: [{ role: 'user', content: buildInlineEditPrompt(copy.ad_copy, instruction, copy.ad_copy) }],
    });

    const editedCopy = response.content?.[0]?.text?.match(/<adcopy>([\s\S]*?)<\/adcopy>/)?.[1]?.trim() || response.content?.[0]?.text || copy.ad_copy;
    const wordCount = editedCopy.split(/\s+/).filter(Boolean).length;

    const updated = await pgQuery(
      'UPDATE advertorial_copies SET ad_copy = $1, ad_copy_word_count = $2, generation = generation + 1, rewrite_prompt = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [editedCopy, wordCount, instruction, req.params.id]
    );

    res.json({ success: true, data: updated[0] });
  } catch (err) {
    console.error('[Advertorial] /ai-edit error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /copies/:id/classify — Classify copy into archetype
router.post('/copies/:id/classify', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('SELECT * FROM advertorial_copies WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    const copy = rows[0];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: buildClassificationPrompt(copy.ad_copy) }],
    });

    const text = response.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse classification JSON');

    let classification;
    try { classification = JSON.parse(jsonMatch[0]); } catch (e) { throw new Error('Failed to parse classification JSON'); }

    const updated = await pgQuery(
      'UPDATE advertorial_copies SET archetype = $1, secondary_archetype = $2, metadata = COALESCE(metadata, \'{}\'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id = $4 RETURNING *',
      [classification.primary_archetype, classification.secondary_archetype, JSON.stringify({ classification }), req.params.id]
    );

    res.json({ success: true, data: updated[0] });
  } catch (err) {
    console.error('[Advertorial] /classify error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /copies/:id/generate-images — V3 archetype image pipeline
router.post('/copies/:id/generate-images', authenticate, async (req, res) => {
  try {
    const { count_ai = 4, count_organic = 2 } = req.body;
    const rows = await pgQuery('SELECT * FROM advertorial_copies WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Copy not found' } });
    const copy = rows[0];

    // Classify if not already
    let archetype = copy.archetype;
    if (!archetype) {
      const classifyRes = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: buildClassificationPrompt(copy.ad_copy) }],
      });
      const classText = classifyRes.content?.[0]?.text || '';
      let classJson = {};
      try { classJson = JSON.parse(classText.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch {}
      archetype = classJson.primary_archetype || 'MIRROR';
      await pgQuery('UPDATE advertorial_copies SET archetype = $1, updated_at = NOW() WHERE id = $2', [archetype, copy.id]);
    }

    const archetypeConfig = ARCHETYPES[archetype] || ARCHETYPES.MIRROR;

    // Generate concepts via Claude
    const conceptRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildConceptPrompt(archetype, copy.ad_copy) }],
    });
    const conceptText = conceptRes.content?.[0]?.text || '';
    let conceptsJson = [];
    try { conceptsJson = JSON.parse(conceptText.match(/\[[\s\S]*\]/)?.[0] || '[]'); } catch {}

    // Build Gemini prompts from concepts
    const geminiPrompts = conceptsJson.slice(0, count_ai).map(concept => {
      const prompt = buildGeminiPrompt(concept, archetype);
      const validation = validatePrompt(prompt);
      return { prompt, concept, valid: validation.valid, reason: validation.reason };
    }).filter(p => p.valid);

    // Update status
    await pgQuery('UPDATE advertorial_copies SET image_status = $1, status = $2, updated_at = NOW() WHERE id = $3', ['generating', 'images_pending', copy.id]);

    // Generate AI images via Gemini
    const imageResults = await generateImages(
      geminiPrompts.map(p => p.prompt),
      archetypeConfig.systemInstruction,
      '4:5'
    );

    const creatives = [];
    for (let i = 0; i < imageResults.length; i++) {
      const result = imageResults[i];
      if (!result.success) continue;

      let imageUrl = null;
      let r2Key = null;

      if (isR2Configured()) {
        const key = `creatives/advertorial/${copy.product_id}/${crypto.randomUUID()}.png`;
        imageUrl = await uploadBuffer(result.buffer, key, result.mimeType || 'image/png');
        r2Key = key;
      }

      const creative = await pgQuery(
        `INSERT INTO spy_creatives (product_id, pipeline, advertorial_copy_id, image_url, r2_key, angle, archetype, aspect_ratio, generation_provider, generation_model, status)
         VALUES ($1, 'advertorial', $2, $3, $4, $5, $6, '4:5', 'gemini', 'gemini-2.0-flash', 'review')
         RETURNING *`,
        [copy.product_id, copy.id, imageUrl, r2Key, copy.angle, archetype]
      );
      creatives.push(creative[0]);
    }

    // Get organic images if requested
    if (count_organic > 0) {
      const organicRows = await pgQuery(
        `SELECT * FROM organic_images WHERE is_rejected = false AND status = 'active'
         ORDER BY usage_count ASC, last_used_at ASC NULLS FIRST LIMIT $1`,
        [count_organic]
      );
      for (const organic of organicRows) {
        const creative = await pgQuery(
          `INSERT INTO spy_creatives (product_id, pipeline, advertorial_copy_id, image_url, angle, archetype, is_organic, status)
           VALUES ($1, 'advertorial', $2, $3, $4, $5, true, 'review')
           RETURNING *`,
          [copy.product_id, copy.id, organic.image_url, copy.angle, archetype]
        );
        creatives.push(creative[0]);
        await pgQuery('UPDATE organic_images SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1', [organic.id]);
      }
    }

    // Update copy status
    await pgQuery('UPDATE advertorial_copies SET image_status = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [creatives.length > 0 ? 'complete' : 'failed', creatives.length > 0 ? 'images_review' : 'copy_approved', copy.id]);

    res.json({ success: true, data: { creatives, generated: creatives.length } });
  } catch (err) {
    console.error('[Advertorial] /generate-images error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /organic-images — Browse organic pool
router.get('/organic-images', authenticate, async (req, res) => {
  try {
    const { source, tags, limit = 50 } = req.query;
    let query = "SELECT * FROM organic_images WHERE is_rejected = false AND status = 'active'";
    const params = [];
    let idx = 1;
    if (source) { query += ` AND source = $${idx++}`; params.push(source); }
    if (tags) { query += ` AND tags @> $${idx++}::jsonb`; params.push(JSON.stringify([tags])); }
    query += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(parseInt(limit));
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /organic-images/scrape — Trigger Reddit scrape
router.post('/organic-images/scrape', authenticate, async (req, res) => {
  try {
    const { subreddit, query: searchQuery, limit = 25 } = req.body;
    if (!subreddit) return res.status(400).json({ success: false, error: { message: 'subreddit is required' } });

    // Create job
    const jobs = await pgQuery(
      "INSERT INTO image_scrape_jobs (platform, keyword, subreddit, status, started_at) VALUES ('reddit', $1, $2, 'running', NOW()) RETURNING *",
      [searchQuery || '', subreddit]
    );
    const job = jobs[0];

    // Run scrape async
    (async () => {
      try {
        const { searchSubreddit } = await import('../services/redditScraper.js');
        const posts = await searchSubreddit(subreddit, searchQuery || '', limit);

        let saved = 0;
        for (const post of posts) {
          try {
            // Check for duplicate
            const existing = await pgQuery('SELECT id FROM organic_images WHERE source_url = $1', [post.sourceUrl]);
            if (existing.length > 0) continue;

            let imageUrl = post.imageUrl;
            let r2Key = null;
            if (isR2Configured()) {
              const result = await uploadFromUrl(post.imageUrl, 'organic');
              imageUrl = result.url;
              r2Key = result.key;
            }

            await pgQuery(
              `INSERT INTO organic_images (image_url, r2_key, source, source_url, title, author, upvotes, subreddit, scrape_keyword, scrape_job_id, tags)
               VALUES ($1, $2, 'reddit', $3, $4, $5, $6, $7, $8, $9, $10)`,
              [imageUrl, r2Key, post.sourceUrl, post.title, post.author, post.upvotes, subreddit, searchQuery || '', job.id, JSON.stringify([])]
            );
            saved++;
          } catch (e) { console.warn('[Scrape] Failed to save image:', e.message); }
        }

        await pgQuery("UPDATE image_scrape_jobs SET status = 'completed', images_found = $1, images_saved = $2, completed_at = NOW() WHERE id = $3", [posts.length, saved, job.id]);
      } catch (err) {
        await pgQuery("UPDATE image_scrape_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2", [err.message, job.id]);
      }
    })();

    res.json({ success: true, data: job });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /scrape-jobs — List scrape jobs
router.get('/scrape-jobs', authenticate, async (req, res) => {
  try {
    const rows = await pgQuery('SELECT * FROM image_scrape_jobs ORDER BY created_at DESC LIMIT 20');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
