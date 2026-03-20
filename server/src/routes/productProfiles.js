import { Router } from 'express';
import { pgQuery } from '../db/pg.js';

const router = Router();

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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrations for existing tables
  await pgQuery(`ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS logos JSONB DEFAULT '[]'`).catch(() => {});
  await pgQuery(`ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS fonts JSONB DEFAULT '[]'`).catch(() => {});
  await pgQuery(`ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_code TEXT`).catch(() => {});

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
];

const JSONB_FIELDS = new Set([
  'product_images', 'logos', 'fonts', 'benefits', 'angles', 'scripts', 'offers', 'brand_colors',
]);

// ── GET / — List all profiles ───────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM product_profiles ORDER BY updated_at DESC');
    return res.json({ success: true, data: rows });
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
    return res.json({ success: true, data: rows[0] });
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
        values.push(JSONB_FIELDS.has(field) ? JSON.stringify(req.body[field]) : req.body[field]);
        idx++;
      }
    }

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const columns = fields.join(', ');

    const rows = await pgQuery(
      `INSERT INTO product_profiles (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    return res.status(201).json({ success: true, data: rows[0] });
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
        setClauses.push(`${field} = $${idx}`);
        values.push(JSONB_FIELDS.has(field) ? JSON.stringify(req.body[field]) : req.body[field]);
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

    return res.json({ success: true, data: rows[0] });
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
    return res.json({ success: true, data: rows[0] });
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
    return res.json({ success: true, data: rows[0] });
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
    return res.json({ success: true, data: rows[0] });
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
    return res.json({ success: true, data: rows[0] });
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
    return res.json({ success: true, data: rows[0] });
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
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /product-profiles/:id/benefits error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
