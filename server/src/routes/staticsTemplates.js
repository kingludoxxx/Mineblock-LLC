import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { buildLayoutAnalysisPrompt } from '../utils/staticsPrompts.js';
import { resolveImage } from '../utils/imageHelpers.js';
import { analyzeTemplate } from '../utils/templateAnalysis.js';

const router = Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// ── Ensure table ───────────────────────────────────────────────────────

let tableReadyPromise = null;
async function ensureTable() {
  if (tableReadyPromise) return tableReadyPromise;
  tableReadyPromise = (async () => {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS statics_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Uncategorized',
      image_url TEXT NOT NULL,
      r2_key TEXT,
      thumbnail_url TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      is_hidden BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_statics_templates_category ON statics_templates(category)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_statics_templates_hidden ON statics_templates(is_hidden)`);
  })();
  return tableReadyPromise;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function categorizeImage(imageUrl) {
  // Always resolve to base64 — Claude API can't fetch many external URLs (Shopify CDN, etc.)
  let imageContent;
  if (imageUrl.startsWith('data:')) {
    const mediaType = imageUrl.match(/data:([^;]+)/)?.[1] || 'image/png';
    const data = imageUrl.split(',')[1];
    imageContent = { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  } else {
    try {
      const resolved = await resolveImage(imageUrl);
      imageContent = { type: 'image', source: { type: 'base64', media_type: resolved.mediaType, data: resolved.base64 } };
    } catch (fetchErr) {
      console.warn('[staticsTemplates] Could not download image, trying URL mode:', fetchErr.message);
      imageContent = { type: 'image', source: { type: 'url', url: imageUrl } };
    }
  }

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this static ad template image. Classify it into ONE of these exact categories:
Headline, Feature/Benefit, Offer/Sale, Testimonial, Before & After, Us vs Them, Article/News, Native, Bold Claim, Statistics, Problem + Solution, Google Search, Apple Notes, AirDrop, Meme, Negative Hook, What's Inside, Uncategorized

Return a JSON object with:
- "category": one of the exact categories above
- "tags": an array of 3-5 descriptive tags (e.g. ["before-after", "product-comparison", "dark-theme"])
Return ONLY valid JSON, no markdown fences.`,
          },
          imageContent,
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text;
  if (!rawText) throw new Error('Empty response from Claude');

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse JSON from Claude response');

  let result;
  try { result = JSON.parse(jsonMatch[0]); }
  catch (parseErr) { throw new Error(`Failed to parse Claude JSON: ${parseErr.message}`); }
  return result;
}

// ── GET / — List templates ──────────────────────────────────────────────

router.get('/', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { category, search, hidden } = req.query;
    const showHidden = hidden === 'true';

    let query = 'SELECT * FROM statics_templates WHERE 1=1';
    const params = [];
    let idx = 1;

    if (!showHidden) {
      query += ` AND is_hidden = false`;
    }
    if (category) {
      query += ` AND category = $${idx++}`;
      params.push(category);
    }
    if (search) {
      const searchTerm = `%${search}%`;
      query += ` AND (name ILIKE $${idx} OR category ILIKE $${idx + 1})`;
      params.push(searchTerm, searchTerm);
      idx += 2;
    }

    query += ' ORDER BY sort_order ASC, created_at DESC';
    const templates = await pgQuery(query, params);

    const categories = await pgQuery(`
      SELECT category AS name, COUNT(*)::int AS count
      FROM statics_templates
      WHERE is_hidden = false
      GROUP BY category
      ORDER BY count DESC
    `);

    res.json({ success: true, data: templates, categories });
  } catch (err) {
    console.error('[staticsTemplates] GET / error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── GET /categories — Distinct categories with counts ───────────────────

router.get('/categories', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery(`
      SELECT category AS name, COUNT(*)::int AS count
      FROM statics_templates
      WHERE is_hidden = false
      GROUP BY category
      ORDER BY count DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[staticsTemplates] GET /categories error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── GET /:id — Single template ──────────────────────────────────────────

router.get('/:id', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM statics_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsTemplates] GET /:id error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST / — Create template ────────────────────────────────────────────

router.post('/', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { name, category, image_url, tags } = req.body;
    if (!name || !image_url) {
      return res.status(400).json({ success: false, error: { message: 'name and image_url are required' } });
    }

    const rows = await pgQuery(
      `INSERT INTO statics_templates (name, category, image_url, tags)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, category || 'Uncategorized', image_url, JSON.stringify(tags || [])]
    );
    const created = rows[0];
    res.status(201).json({ success: true, data: created });

    // Auto-analyze in background (don't block the response)
    if (created?.id && created?.image_url) {
      analyzeTemplate(created).then(async (analysis) => {
        const updated = await pgQuery(
          `UPDATE statics_templates SET deep_analysis = $1, analyzed_at = NOW() WHERE id = $2 RETURNING id`,
          [JSON.stringify(analysis), created.id]
        );
        if (updated.length) {
          console.log(`[staticsTemplates] Auto-analyzed template ${created.id}`);
        }
      }).catch(err => {
        console.error(`[staticsTemplates] Auto-analyze failed for ${created.id}:`, err.message);
      });
    }
  } catch (err) {
    console.error('[staticsTemplates] POST / error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /bulk-import — Temporary unauthenticated import (CORS-enabled) ──
router.options('/bulk-import', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.sendStatus(204);
});
router.post('/bulk-import', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    await ensureTable();
    let { templates } = req.body;
    // Handle form-urlencoded POST (templates comes as a JSON string)
    if (typeof templates === 'string') { try { templates = JSON.parse(templates); } catch { return res.status(400).json({ error: 'invalid JSON' }); } }
    if (!Array.isArray(templates)) return res.status(400).json({ error: 'templates array required' });
    // Batch insert for performance (up to 200 per query)
    const valid = templates.filter(t => t.name && t.image_url);
    let count = 0;
    for (let i = 0; i < valid.length; i += 200) {
      const batch = valid.slice(i, i + 200);
      const values = [];
      const params = [];
      batch.forEach((t, idx) => {
        const off = idx * 4;
        values.push(`($${off+1}, $${off+2}, $${off+3}, $${off+4})`);
        params.push(t.name, t.category || 'Uncategorized', t.image_url, JSON.stringify(t.tags || []));
      });
      await pgQuery(
        `INSERT INTO statics_templates (name, category, image_url, tags) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
        params
      );
      count += batch.length;
    }
    res.status(201).json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /bulk — Bulk create templates ──────────────────────────────────

router.post('/bulk', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { templates } = req.body;
    if (!Array.isArray(templates) || templates.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'templates array is required' } });
    }

    let count = 0;
    for (const t of templates) {
      if (!t.name || !t.image_url) continue;
      await pgQuery(
        `INSERT INTO statics_templates (name, category, image_url, tags)
         VALUES ($1, $2, $3, $4)`,
        [t.name, t.category || 'Uncategorized', t.image_url, JSON.stringify(t.tags || [])]
      );
      count++;
    }

    res.status(201).json({ success: true, data: { count } });
  } catch (err) {
    console.error('[staticsTemplates] POST /bulk error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── PUT /:id — Update template ──────────────────────────────────────────

router.put('/:id', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { name, category, tags, is_hidden, sort_order } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined)       { sets.push(`name = $${idx++}`);       params.push(name); }
    if (category !== undefined)   { sets.push(`category = $${idx++}`);   params.push(category); }
    if (tags !== undefined)       { sets.push(`tags = $${idx++}::jsonb`); params.push(JSON.stringify(Array.isArray(tags) ? tags : [])); }
    if (is_hidden !== undefined)  { sets.push(`is_hidden = $${idx++}`);  params.push(is_hidden); }
    if (sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(sort_order); }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No fields to update' } });
    }

    sets.push('updated_at = NOW()');
    params.push(req.params.id);

    const rows = await pgQuery(
      `UPDATE statics_templates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[staticsTemplates] PUT /:id error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id — Delete template ───────────────────────────────────────

router.delete('/:id', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('DELETE FROM statics_templates WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('[staticsTemplates] DELETE /:id error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/categorize — AI categorize single template ────────────────

router.post('/:id/categorize', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM statics_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });

    const template = rows[0];
    const result = await categorizeImage(template.image_url);

    const updated = await pgQuery(
      `UPDATE statics_templates SET category = $1, tags = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [result.category || 'Uncategorized', JSON.stringify(result.tags || []), req.params.id]
    );

    res.json({ success: true, data: updated[0] });
  } catch (err) {
    console.error('[staticsTemplates] POST /:id/categorize error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /ai-scan — Bulk AI categorize ──────────────────────────────────

router.post('/ai-scan', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'ids array is required' } });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const templates = await pgQuery(
      `SELECT * FROM statics_templates WHERE id IN (${placeholders})`,
      ids
    );

    const results = [];
    for (const template of templates) {
      try {
        const result = await categorizeImage(template.image_url);
        const updated = await pgQuery(
          `UPDATE statics_templates SET category = $1, tags = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
          [result.category || 'Uncategorized', JSON.stringify(result.tags || []), template.id]
        );
        results.push({ id: template.id, status: 'success', data: updated[0] });
      } catch (err) {
        results.push({ id: template.id, status: 'error', error: err.message });
      }
    }

    res.json({ success: true, data: { total: ids.length, processed: results.length, results } });
  } catch (err) {
    console.error('[staticsTemplates] POST /ai-scan error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/analyze-layout — Run layout analysis and cache ───────────

router.post('/:id/analyze-layout', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM statics_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: { message: 'Template not found' } });

    const template = rows[0];
    const meta = typeof template.metadata === 'string' ? JSON.parse(template.metadata) : (template.metadata || {});

    // Return cached unless force=true
    if (meta.layout_map && req.query.force !== 'true') {
      return res.json({ success: true, data: meta.layout_map, cached: true });
    }

    // Analyze
    const { base64, mediaType } = await resolveImage(template.image_url);
    const { system, user } = buildLayoutAnalysisPrompt();

    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: user },
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            ],
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${errText.slice(0, 300)}`);
    }

    const data = await claudeRes.json();
    const rawText = data.content?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Claude');

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in layout analysis response');

    let layoutMap;
    try {
      layoutMap = JSON.parse(jsonMatch[0]);
    } catch (e) {
      let fixable = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      layoutMap = JSON.parse(fixable);
    }

    // Cache in metadata
    await pgQuery(
      `UPDATE statics_templates
       SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{layout_map}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(layoutMap), req.params.id]
    );

    console.log(`[staticsTemplates] Layout analyzed for ${req.params.id}: archetype=${layoutMap.archetype}`);
    res.json({ success: true, data: layoutMap, cached: false });
  } catch (err) {
    console.error('[staticsTemplates] POST /:id/analyze-layout error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /bulk-analyze-layout — Bulk layout analysis ───────────────────

router.post('/bulk-analyze-layout', authenticate, async (req, res) => {
  try {
    await ensureTable();
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'ids array is required' } });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const templates = await pgQuery(
      `SELECT * FROM statics_templates WHERE id IN (${placeholders})`,
      ids
    );

    const results = [];
    for (const template of templates) {
      try {
        const meta = typeof template.metadata === 'string' ? JSON.parse(template.metadata) : (template.metadata || {});
        if (meta.layout_map) {
          results.push({ id: template.id, status: 'cached', archetype: meta.layout_map.archetype });
          continue;
        }

        const { base64, mediaType } = await resolveImage(template.image_url);
        const { system, user } = buildLayoutAnalysisPrompt();

        const claudeRes = await fetch(CLAUDE_API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 3000,
            system,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: user },
                  { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                ],
              },
            ],
          }),
        });

        if (!claudeRes.ok) throw new Error(`Claude error ${claudeRes.status}`);
        const data = await claudeRes.json();
        const rawText = data.content?.[0]?.text;
        const jsonMatch = (rawText || '').match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON');

        let layoutMap;
        try { layoutMap = JSON.parse(jsonMatch[0]); }
        catch { layoutMap = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, '$1')); }

        await pgQuery(
          `UPDATE statics_templates SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{layout_map}', $1::jsonb), updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(layoutMap), template.id]
        );

        results.push({ id: template.id, status: 'analyzed', archetype: layoutMap.archetype });
      } catch (err) {
        results.push({ id: template.id, status: 'error', error: err.message });
      }
    }

    res.json({ success: true, data: { total: ids.length, results } });
  } catch (err) {
    console.error('[staticsTemplates] POST /bulk-analyze-layout error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
