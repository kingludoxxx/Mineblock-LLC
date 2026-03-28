import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

let tableReady = false;

// ── Ensure Table Exists ─────────────────────────────────────────────

async function ensureTable() {
  if (tableReady) return;

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS product_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price TEXT,
      category TEXT DEFAULT 'supplement',
      logo_url TEXT,
      product_code TEXT,
      logos JSONB DEFAULT '[]',
      fonts JSONB DEFAULT '[]',
      product_images JSONB DEFAULT '[]',
      oneliner TEXT,
      tagline TEXT,
      customer_avatar TEXT,
      customer_frustration TEXT,
      customer_dream TEXT,
      big_promise TEXT,
      mechanism TEXT,
      differentiator TEXT,
      voice TEXT,
      guarantee TEXT,
      benefits JSONB DEFAULT '[]',
      angles JSONB DEFAULT '[]',
      scripts JSONB DEFAULT '[]',
      offers JSONB DEFAULT '[]',
      target_demographics TEXT,
      brand_colors JSONB DEFAULT '{}',
      short_name TEXT,
      product_type TEXT,
      product_group TEXT,
      unit_details TEXT,
      product_url TEXT,
      pain_points TEXT,
      common_objections TEXT,
      winning_angles TEXT,
      custom_angles_text TEXT,
      compliance_restrictions TEXT,
      competitive_edge TEXT,
      offer_details TEXT,
      max_discount TEXT,
      discount_codes TEXT,
      bundle_variants TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrations for existing tables
  await pgQuery(`
    DO $$ BEGIN
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS logos JSONB DEFAULT '[]';
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS fonts JSONB DEFAULT '[]';
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_code TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS short_name TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_type TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_group TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS unit_details TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_url TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS pain_points TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS common_objections TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS winning_angles TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS custom_angles_text TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS compliance_restrictions TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS competitive_edge TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS offer_details TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS max_discount TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS discount_codes TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS bundle_variants TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);

  tableReady = true;
}

ensureTable().catch(console.error);

// ── Helpers ─────────────────────────────────────────────────────────

const UPDATABLE_FIELDS = [
  'name', 'description', 'price', 'category', 'product_code', 'logo_url', 'logos', 'fonts', 'product_images',
  'oneliner', 'tagline', 'customer_avatar', 'customer_frustration',
  'customer_dream', 'big_promise', 'mechanism', 'differentiator', 'voice',
  'guarantee', 'benefits', 'angles', 'scripts', 'offers',
  'target_demographics', 'brand_colors',
  'short_name', 'product_type', 'product_group', 'unit_details', 'product_url',
  'pain_points', 'common_objections', 'winning_angles', 'custom_angles_text',
  'compliance_restrictions', 'competitive_edge', 'offer_details',
  'max_discount', 'discount_codes', 'bundle_variants',
];

const JSONB_FIELDS = new Set([
  'product_images', 'logos', 'fonts', 'benefits', 'angles', 'scripts', 'offers', 'brand_colors',
]);

// postgres.js unsafe() returns JSONB columns as strings — parse them before sending
function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of JSONB_FIELDS) {
    if (typeof out[field] === 'string') {
      try { out[field] = JSON.parse(out[field]); } catch { out[field] = field === 'brand_colors' ? {} : []; }
    }
  }
  return out;
}

// ── GET / — List all profiles ───────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM product_profiles ORDER BY updated_at DESC');
    return res.json({ success: true, data: rows.map(parseRow) });
  } catch (err) {
    console.error('GET /product-profiles error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── GET /:id — Get single profile ───────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('GET /product-profiles/:id error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST / — Create profile ─────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    await ensureTable();

    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: { message: 'name is required' } });
    }

    const fields = ['name'];
    const values = [name.trim()];
    let idx = 2;

    for (const field of UPDATABLE_FIELDS) {
      if (field === 'name') continue;
      if (req.body[field] !== undefined) {
        fields.push(field);
        const v = req.body[field];
        values.push(JSONB_FIELDS.has(field) ? (typeof v === 'string' ? v : JSON.stringify(v)) : v);
        idx++;
      }
    }

    const placeholders = fields.map((f, i) => JSONB_FIELDS.has(f) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
    const columns = fields.join(', ');

    const rows = await pgQuery(
      `INSERT INTO product_profiles (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    return res.status(201).json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── PUT /:id — Update profile ───────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    await ensureTable();

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        if (JSONB_FIELDS.has(field)) {
          setClauses.push(`${field} = $${idx}::jsonb`);
          const v = req.body[field];
          values.push(typeof v === 'string' ? v : JSON.stringify(v));
        } else {
          setClauses.push(`${field} = $${idx}`);
          values.push(req.body[field]);
        }
        idx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No fields to update' } });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const rows = await pgQuery(
      `UPDATE product_profiles SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }

    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('PUT /product-profiles/:id error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id — Delete profile ────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery(
      'DELETE FROM product_profiles WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /product-profiles/:id error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/images — Add image URL ───────────────────────────────

router.post('/:id/images', async (req, res) => {
  try {
    await ensureTable();
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: { message: 'url is required' } });
    }

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET product_images = product_images || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([url]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/images error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id/images — Remove image URL ───────────────────────────

router.delete('/:id/images', async (req, res) => {
  try {
    await ensureTable();
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: { message: 'url is required' } });
    }

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET product_images = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(product_images) AS elem
         WHERE elem #>> '{}' != $1
       ),
       updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [url, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('DELETE /product-profiles/:id/images error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/scripts — Add script ─────────────────────────────────

router.post('/:id/scripts', async (req, res) => {
  try {
    await ensureTable();
    const { title, content, type } = req.body;
    if (!title || !content) {
      return res.status(400).json({ success: false, error: { message: 'title and content are required' } });
    }

    const script = {
      id: `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      content,
      type: type || 'other',
      created_at: new Date().toISOString(),
    };

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET scripts = scripts || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([script]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/scripts error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id/scripts/:scriptId — Remove script ───────────────────

router.delete('/:id/scripts/:scriptId', async (req, res) => {
  try {
    await ensureTable();

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET scripts = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(scripts) AS elem
         WHERE elem->>'id' != $1
       ),
       updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.params.scriptId, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('DELETE /product-profiles/:id/scripts/:scriptId error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/angles — Add angle ───────────────────────────────────

router.post('/:id/angles', async (req, res) => {
  try {
    await ensureTable();
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: { message: 'name is required' } });
    }

    const angle = {
      id: `angle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: description || '',
      created_at: new Date().toISOString(),
    };

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET angles = angles || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([angle]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/angles error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/benefits — Add benefit ───────────────────────────────

router.post('/:id/benefits', async (req, res) => {
  try {
    await ensureTable();
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, error: { message: 'text is required' } });
    }

    const benefit = {
      id: `benefit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      created_at: new Date().toISOString(),
    };

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET benefits = benefits || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([benefit]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/benefits error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/ai-fill — AI auto-fill from product URL ─────────────
router.post('/:id/ai-fill', async (req, res) => {
  try {
    await ensureTable();
    const { url } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, error: { message: 'url is required' } });
    }

    // Fetch the product page
    let pageContent;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      });
      pageContent = await resp.text();
      // Strip HTML tags for cleaner text, keep structure
      pageContent = pageContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 15000); // Limit to avoid token overflow
    } catch (fetchErr) {
      return res.status(400).json({ success: false, error: { message: `Failed to fetch URL: ${fetchErr.message}` } });
    }

    // Call Claude to extract product info
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const extraction = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Analyze this product page content and extract ALL available product information. Return a JSON object with these fields (use empty string "" for any field you cannot determine):

{
  "name": "Full product name",
  "short_name": "Short/abbreviated name",
  "product_type": "Product type (e.g. Capsules, Powder, Cream, Software, Course)",
  "product_group": "Product category (e.g. Supplements, Skincare, SaaS)",
  "unit_details": "Unit/packaging info (e.g. 1 Jar / 24 Capsules, Monthly subscription)",
  "price": "Price as shown",
  "description": "Full product description and how it works (2-3 paragraphs)",
  "oneliner": "One punchy sentence about the product",
  "tagline": "Short marketing tagline",
  "big_promise": "The #1 transformation/result the product delivers",
  "mechanism": "How the product works — the unique mechanism or approach",
  "differentiator": "What makes this different from competitors",
  "customer_avatar": "Who is this product for — detailed customer profile",
  "customer_frustration": "What problems/frustrations does the customer have",
  "customer_dream": "What does the ideal outcome look like for the customer",
  "target_demographics": "Age, gender, location, income level etc.",
  "voice": "Brand voice and tone description",
  "pain_points": "Customer pain points and emotional triggers that drive purchase",
  "common_objections": "Common objections and how to handle them (bullet points with arrows)",
  "winning_angles": "Marketing angles that would work well for this product",
  "custom_angles_text": "Creative new angles to test",
  "guarantee": "Money-back guarantee or risk reversal",
  "competitive_edge": "What makes this better than alternatives and why buy now",
  "offer_details": "Current offers, discounts, bundles",
  "max_discount": "Maximum discount percentage allowed in ads (e.g. 30% off)",
  "discount_codes": "Active discount/promo codes and what they do (e.g. SAVE20 = 20% off first order)",
  "bundle_variants": "Available product bundles/variants with pricing (e.g. 1 bottle $49, 3 bottles $117, 6 bottles $198)",
  "compliance_restrictions": "Claims the AI should NEVER make (health claims, guarantees, etc.)",
  "benefits": ["benefit 1", "benefit 2", "benefit 3"]
}

Return ONLY valid JSON, no markdown or explanation.

Product page content:
${pageContent}`
      }]
    });

    let extracted;
    try {
      const text = extraction.content[0].text.trim();
      // Handle potential markdown code blocks
      const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      return res.status(500).json({ success: false, error: { message: 'Failed to parse AI response' } });
    }

    // Save extracted data to the profile
    const setClauses = [];
    const values = [];
    let idx = 1;

    const fieldsToSave = [
      'name', 'short_name', 'product_type', 'product_group', 'unit_details',
      'price', 'description', 'oneliner', 'tagline', 'big_promise', 'mechanism',
      'differentiator', 'customer_avatar', 'customer_frustration', 'customer_dream',
      'target_demographics', 'voice', 'pain_points', 'common_objections',
      'winning_angles', 'custom_angles_text', 'guarantee', 'competitive_edge',
      'offer_details', 'max_discount', 'discount_codes', 'bundle_variants',
      'compliance_restrictions',
    ];

    for (const field of fieldsToSave) {
      if (typeof extracted[field] === 'string' && extracted[field].trim()) {
        setClauses.push(`${field} = $${idx}`);
        values.push(extracted[field]);
        idx++;
      }
    }

    // Handle benefits array
    if (Array.isArray(extracted.benefits) && extracted.benefits.length > 0) {
      setClauses.push(`benefits = $${idx}`);
      values.push(JSON.stringify(extracted.benefits));
      idx++;
    }

    // Save product URL
    setClauses.push(`product_url = $${idx}`);
    values.push(url);
    idx++;

    setClauses.push('updated_at = NOW()');
    values.push(req.params.id);

    const rows = await pgQuery(
      `UPDATE product_profiles SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }

    return res.json({ success: true, data: rows[0], extracted });
  } catch (err) {
    console.error('POST /product-profiles/:id/ai-fill error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
