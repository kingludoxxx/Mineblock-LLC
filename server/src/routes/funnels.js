// Funnel Builder — slice 1: funnel + page CRUD with a JSON blocks editor.
// No public rendering in this slice; that lands later. Blocks are validated
// on WRITE (array of {type: string, props: plain object}) because a bad
// props value 500s an entire published page later — the write is the defense.
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, requirePermission('funnels', 'access'));

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries.
let tablesReadyPromise = null;

function ensureTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables().catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

async function createTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS funnels (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      custom_domain TEXT,
      default_page_id TEXT,
      seo JSONB DEFAULT '{}',
      flow_layout JSONB DEFAULT '{"nodes":[],"edges":[]}',
      misc JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Partial unique: trashing (archived=true) frees the slug for reuse.
  await pgQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_funnels_slug ON funnels (slug) WHERE NOT archived`
  );

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS funnel_pages (
      id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL REFERENCES funnels(id),
      slug TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      is_home BOOLEAN NOT NULL DEFAULT FALSE,
      blocks JSONB NOT NULL DEFAULT '[]',
      seo JSONB DEFAULT '{}',
      custom_html TEXT DEFAULT '', custom_css TEXT DEFAULT '', custom_js TEXT DEFAULT '',
      head_html TEXT DEFAULT '', body_end_html TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_pages_slug ON funnel_pages (funnel_id, slug) WHERE NOT archived`
  );
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_funnel_pages_serve ON funnel_pages (funnel_id, slug)`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_TYPES = [
  'listicle',
  'lead',
  'quiz',
  'checkout',
  'upsell',
  'downsell',
  'thankyou',
  'generic',
];
const FUNNEL_SLUG_RE = /^[a-z0-9-]+$/;
const PAGE_SLUG_RE = /^\/$|^\/[a-z0-9-]+$/;
const ESCAPE_HATCH_FIELDS = ['custom_html', 'custom_css', 'custom_js', 'head_html', 'body_end_html'];
const ESCAPE_HATCH_MAX = 2 * 1024 * 1024; // 2MB per field
const UNIQUE_VIOLATION = '23505';

const genId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`; // 14 hex chars

const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const isPlainObject = (v) =>
  v != null && typeof v === 'object' && !Array.isArray(v);

// Blocks must be an array of {type: string, props: plain object}. Returns an
// error string or null. Rejecting bad shapes here is what keeps the public
// renderer from 500ing later.
function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!isPlainObject(b)) return `blocks[${i}] must be an object`;
    if (typeof b.type !== 'string' || !b.type.trim())
      return `blocks[${i}].type must be a non-empty string`;
    if (!isPlainObject(b.props))
      return `blocks[${i}].props must be a plain object`;
  }
  return null;
}

async function getFunnel(id) {
  const rows = await pgQuery(`SELECT * FROM funnels WHERE id = $1`, [id]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Funnels
// ---------------------------------------------------------------------------

// GET /api/v1/funnels — list with page counts (+ search, archived filter)
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const where = [];
    const params = [];
    let i = 1;
    where.push(req.query.archived === 'true' ? `f.archived = TRUE` : `f.archived = FALSE`);
    if (req.query.q) {
      where.push(`(f.name ILIKE $${i} OR f.slug ILIKE $${i})`);
      params.push(`%${req.query.q}%`);
      i += 1;
    }
    const rows = await pgQuery(
      `SELECT f.*,
              COALESCE(p.n, 0)::int AS pages_count
       FROM funnels f
       LEFT JOIN (
         SELECT funnel_id, COUNT(*) AS n
         FROM funnel_pages WHERE archived = FALSE GROUP BY funnel_id
       ) p ON p.funnel_id = f.id
       WHERE ${where.join(' AND ')}
       ORDER BY f.updated_at DESC`,
      params
    );
    res.json({ success: true, data: { funnels: rows, total: rows.length } });
  } catch (err) {
    console.error('[funnels] list failed:', err);
    res.status(500).json({ error: 'Failed to load funnels' });
  }
});

// POST /api/v1/funnels — { name, slug? } (slug auto-derived from name)
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const slug = req.body?.slug != null ? String(req.body.slug).trim() : slugify(name);
    if (!FUNNEL_SLUG_RE.test(slug)) {
      return res
        .status(400)
        .json({ error: 'slug must be lowercase letters, numbers and dashes' });
    }
    const id = genId('fnl');
    const rows = await pgQuery(
      `INSERT INTO funnels (id, slug, name) VALUES ($1, $2, $3) RETURNING *`,
      [id, slug, name]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'A funnel with this slug already exists' });
    }
    console.error('[funnels] create failed:', err);
    res.status(500).json({ error: 'Failed to create funnel' });
  }
});

// GET /api/v1/funnels/:id — funnel + its non-archived pages
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    const pages = await pgQuery(
      `SELECT * FROM funnel_pages
       WHERE funnel_id = $1 AND archived = FALSE
       ORDER BY is_home DESC, created_at ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: { funnel, pages } });
  } catch (err) {
    console.error('[funnels] detail failed:', err);
    res.status(500).json({ error: 'Failed to load funnel' });
  }
});

// PATCH /api/v1/funnels/:id — { name?, slug?, status?, default_page_id?, seo? }
router.patch('/:id', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });

    const body = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      sets.push(`name = $${i}`);
      params.push(name);
      i += 1;
    }
    if (body.slug !== undefined) {
      const slug = String(body.slug).trim();
      if (!FUNNEL_SLUG_RE.test(slug)) {
        return res
          .status(400)
          .json({ error: 'slug must be lowercase letters, numbers and dashes' });
      }
      sets.push(`slug = $${i}`);
      params.push(slug);
      i += 1;
    }
    if (body.status !== undefined) {
      const status = String(body.status).trim();
      if (!status || status.length > 64) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      sets.push(`status = $${i}`);
      params.push(status);
      i += 1;
    }
    if (body.default_page_id !== undefined) {
      if (body.default_page_id === null) {
        sets.push(`default_page_id = NULL`);
      } else {
        const pageId = String(body.default_page_id);
        const page = await pgQuery(
          `SELECT id FROM funnel_pages WHERE id = $1 AND funnel_id = $2 AND archived = FALSE`,
          [pageId, req.params.id]
        );
        if (!page.length) {
          return res
            .status(400)
            .json({ error: 'default_page_id does not reference a page of this funnel' });
        }
        sets.push(`default_page_id = $${i}`);
        params.push(pageId);
        i += 1;
      }
    }
    if (body.seo !== undefined) {
      if (!isPlainObject(body.seo)) {
        return res.status(400).json({ error: 'seo must be an object' });
      }
      sets.push(`seo = $${i}`);
      params.push(body.seo); // postgres.js serializes JSONB itself — pass raw
      i += 1;
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const rows = await pgQuery(
      `UPDATE funnels SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'A funnel with this slug already exists' });
    }
    console.error('[funnels] update failed:', err);
    res.status(500).json({ error: 'Failed to update funnel' });
  }
});

// POST /api/v1/funnels/:id/archive — { archived: true|false }. Archive is the
// only "delete" — never hard-delete. Archiving frees the slug (partial index).
router.post('/:id/archive', async (req, res) => {
  try {
    await ensureTables();
    const archived = req.body?.archived !== false;
    const rows = await pgQuery(
      `UPDATE funnels SET archived = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, archived]
    );
    if (!rows.length) return res.status(404).json({ error: 'Funnel not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) {
      // Un-archiving while another live funnel took the slug in the meantime
      return res
        .status(409)
        .json({ error: 'Cannot restore: a live funnel already uses this slug' });
    }
    console.error('[funnels] archive failed:', err);
    res.status(500).json({ error: 'Failed to archive funnel' });
  }
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// POST /api/v1/funnels/:id/pages — { title, slug, type? }
router.post('/:id/pages', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });

    const title = String(req.body?.title || '').trim();
    const slug = String(req.body?.slug || '').trim();
    const type = req.body?.type != null ? String(req.body.type) : 'generic';
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!PAGE_SLUG_RE.test(slug)) {
      return res
        .status(400)
        .json({ error: "slug must be '/' or '/' followed by lowercase letters, numbers and dashes" });
    }
    if (!PAGE_TYPES.includes(type)) {
      return res
        .status(400)
        .json({ error: `type must be one of: ${PAGE_TYPES.join(', ')}` });
    }

    // First page of a funnel becomes the home page automatically
    const existing = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM funnel_pages WHERE funnel_id = $1 AND archived = FALSE`,
      [req.params.id]
    );
    const isHome = existing[0].n === 0;

    const id = genId('fpg');
    const rows = await pgQuery(
      `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, is_home)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, req.params.id, slug, type, title, isHome]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res
        .status(409)
        .json({ error: 'A page with this slug already exists in this funnel' });
    }
    console.error('[funnels] page create failed:', err);
    res.status(500).json({ error: 'Failed to create page' });
  }
});

// PATCH /api/v1/funnels/:id/pages/:pageId
router.patch('/:id/pages/:pageId', async (req, res) => {
  try {
    await ensureTables();
    const pageRows = await pgQuery(
      `SELECT * FROM funnel_pages WHERE id = $1 AND funnel_id = $2`,
      [req.params.pageId, req.params.id]
    );
    if (!pageRows.length) return res.status(404).json({ error: 'Page not found' });

    const body = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;

    if (body.title !== undefined) {
      sets.push(`title = $${i}`);
      params.push(String(body.title));
      i += 1;
    }
    if (body.slug !== undefined) {
      const slug = String(body.slug).trim();
      if (!PAGE_SLUG_RE.test(slug)) {
        return res
          .status(400)
          .json({ error: "slug must be '/' or '/' followed by lowercase letters, numbers and dashes" });
      }
      sets.push(`slug = $${i}`);
      params.push(slug);
      i += 1;
    }
    if (body.type !== undefined) {
      if (!PAGE_TYPES.includes(body.type)) {
        return res
          .status(400)
          .json({ error: `type must be one of: ${PAGE_TYPES.join(', ')}` });
      }
      sets.push(`type = $${i}`);
      params.push(body.type);
      i += 1;
    }
    if (body.status !== undefined) {
      const status = String(body.status).trim();
      if (!status || status.length > 64) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      sets.push(`status = $${i}`);
      params.push(status);
      i += 1;
    }
    if (body.blocks !== undefined) {
      const blocksError = validateBlocks(body.blocks);
      if (blocksError) return res.status(400).json({ error: blocksError });
      sets.push(`blocks = $${i}`);
      params.push(body.blocks); // raw array — postgres.js handles JSONB
      i += 1;
    }
    if (body.seo !== undefined) {
      if (!isPlainObject(body.seo)) {
        return res.status(400).json({ error: 'seo must be an object' });
      }
      sets.push(`seo = $${i}`);
      params.push(body.seo);
      i += 1;
    }
    for (const field of ESCAPE_HATCH_FIELDS) {
      if (body[field] !== undefined) {
        const value = String(body[field] ?? '');
        if (Buffer.byteLength(value, 'utf8') > ESCAPE_HATCH_MAX) {
          return res.status(400).json({ error: `${field} exceeds the 2MB limit` });
        }
        sets.push(`${field} = $${i}`);
        params.push(value);
        i += 1;
      }
    }
    if (body.is_home !== undefined && typeof body.is_home !== 'boolean') {
      return res.status(400).json({ error: 'is_home must be a boolean' });
    }
    if (body.is_home === false) {
      sets.push(`is_home = FALSE`);
    }
    if (!sets.length && body.is_home !== true) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (sets.length) {
      sets.push(`updated_at = NOW()`);
      params.push(req.params.pageId, req.params.id);
      await pgQuery(
        `UPDATE funnel_pages SET ${sets.join(', ')}
         WHERE id = $${i} AND funnel_id = $${i + 1}`,
        params
      );
    }

    // Exactly one home page per funnel: one UPDATE flips the whole set —
    // the target becomes home, every sibling is cleared atomically.
    if (body.is_home === true) {
      await pgQuery(
        `UPDATE funnel_pages
         SET is_home = (id = $2), updated_at = CASE WHEN is_home <> (id = $2) THEN NOW() ELSE updated_at END
         WHERE funnel_id = $1 AND archived = FALSE`,
        [req.params.id, req.params.pageId]
      );
    }

    const updated = await pgQuery(
      `SELECT * FROM funnel_pages WHERE id = $1`,
      [req.params.pageId]
    );
    res.json({ success: true, data: updated[0] });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res
        .status(409)
        .json({ error: 'A page with this slug already exists in this funnel' });
    }
    console.error('[funnels] page update failed:', err);
    res.status(500).json({ error: 'Failed to update page' });
  }
});

// POST /api/v1/funnels/:id/pages/:pageId/archive — { archived: true|false }
router.post('/:id/pages/:pageId/archive', async (req, res) => {
  try {
    await ensureTables();
    const archived = req.body?.archived !== false;
    const rows = await pgQuery(
      `UPDATE funnel_pages
       SET archived = $3, is_home = CASE WHEN $3 THEN FALSE ELSE is_home END, updated_at = NOW()
       WHERE id = $1 AND funnel_id = $2 RETURNING *`,
      [req.params.pageId, req.params.id, archived]
    );
    if (!rows.length) return res.status(404).json({ error: 'Page not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res
        .status(409)
        .json({ error: 'Cannot restore: a live page already uses this slug' });
    }
    console.error('[funnels] page archive failed:', err);
    res.status(500).json({ error: 'Failed to archive page' });
  }
});

export default router;
