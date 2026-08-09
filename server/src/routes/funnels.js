// Funnel Builder — slice 1: funnel + page CRUD with a JSON blocks editor.
// No public rendering in this slice; that lands later. Blocks are validated
// on WRITE (array of {type: string, props: plain object}) because a bad
// props value 500s an entire published page later — the write is the defense.
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  checkoutPageTemplate,
  upsellPageTemplate,
  thankYouPageTemplate,
  downsellPageTemplate,
  optinPageTemplate,
  storefrontPageTemplate,
  quizPageTemplate,
  advertorialPageTemplate,
} from '../services/funnelRender.js';

const router = Router();

router.use(authenticate, requirePermission('funnels', 'access'));

// Concurrent requests must not run the DDL simultaneously — Postgres throws
// on parallel CREATE TABLE IF NOT EXISTS (pg_type unique violation). A single
// in-flight promise serializes setup; on failure it resets so the next
// request retries.
let tablesReadyPromise = null;

// Exported for the public serving router (funnelPublic.js) so both entry
// points share ONE serialized DDL promise.
export function ensureTables() {
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

  // Slice 4 — funnel-relative redirects. `from_path`/`to_path` are funnel-root
  // relative ('/old' → serves under /f/<slug>/old). `match` decides exact vs
  // longest-prefix; exact always beats prefix at resolution time (funnel-os
  // DECISIONS/DATA-FLOW: "exact beats longest prefix"). Only `enabled` rows are
  // consulted. No unique index on from_path: an operator may legitimately keep
  // an exact and a prefix rule on the same left-hand side (the resolver
  // disambiguates), and a disabled duplicate is harmless.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS funnel_redirects (
      id TEXT PRIMARY KEY,
      funnel_id TEXT NOT NULL REFERENCES funnels(id),
      from_path TEXT NOT NULL,
      to_path TEXT NOT NULL,
      match TEXT NOT NULL DEFAULT 'exact',
      code INTEGER NOT NULL DEFAULT 301,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgQuery(
    `CREATE INDEX IF NOT EXISTS idx_funnel_redirects_funnel ON funnel_redirects (funnel_id)`
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
  'optin',
  'storefront',
];

// PAGE-TYPES slice: page type → default seed template (funnelRender.js).
// Types absent here (generic, listicle) create an empty canvas, as before.
// 'lead' seeds the advertorial preset (the palette's Lead/Advertorial page).
const PAGE_SEED_TEMPLATES = {
  checkout: checkoutPageTemplate,
  upsell: upsellPageTemplate,
  downsell: downsellPageTemplate,
  thankyou: thankYouPageTemplate,
  optin: optinPageTemplate,
  storefront: storefrontPageTemplate,
  quiz: quizPageTemplate,
  lead: advertorialPageTemplate,
};
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
// renderer from 500ing later. Bounded (count/bytes/depth) and scanned for
// prototype-pollution keys because this exact payload is what the renderer
// will walk — an unbounded or poisoned blob written today is a render-time
// DoS seeded at write time.
const BLOCKS_MAX_COUNT = 500;
const BLOCKS_MAX_BYTES = 2 * 1024 * 1024; // 2MB, same cap as escape hatches
const BLOCKS_MAX_DEPTH = 20;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function scanValue(value, depth) {
  if (depth > BLOCKS_MAX_DEPTH) return 'blocks nesting exceeds the depth limit';
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = scanValue(item, depth + 1);
      if (err) return err;
    }
  } else if (value != null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return `blocks contain a forbidden key: ${key}`;
      const err = scanValue(value[key], depth + 1);
      if (err) return err;
    }
  }
  return null;
}

export function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  if (blocks.length > BLOCKS_MAX_COUNT)
    return `blocks cannot exceed ${BLOCKS_MAX_COUNT} entries`;
  let serialized;
  try {
    serialized = JSON.stringify(blocks);
  } catch {
    return 'blocks must be serializable JSON';
  }
  if (Buffer.byteLength(serialized, 'utf8') > BLOCKS_MAX_BYTES)
    return 'blocks exceed the 2MB limit';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!isPlainObject(b)) return `blocks[${i}] must be an object`;
    if (typeof b.type !== 'string' || !b.type.trim())
      return `blocks[${i}].type must be a non-empty string`;
    if (!isPlainObject(b.props))
      return `blocks[${i}].props must be a plain object`;
  }
  return scanValue(blocks, 0);
}

// Escape LIKE metacharacters so ?q=% cannot act as a wildcard.
const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

// Exactly-one-home repair: if a funnel has live pages but no home (after an
// archive or an un-home), promote the oldest live page. Fail-open caller-side.
async function ensureHomeInvariant(funnelId) {
  await pgQuery(
    `UPDATE funnel_pages SET is_home = TRUE, updated_at = NOW()
     WHERE id = (
       SELECT id FROM funnel_pages
       WHERE funnel_id = $1 AND archived = FALSE
       ORDER BY created_at ASC LIMIT 1
     )
     AND NOT EXISTS (
       SELECT 1 FROM funnel_pages
       WHERE funnel_id = $1 AND archived = FALSE AND is_home = TRUE
     )`,
    [funnelId]
  );
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
      params.push(`%${escapeLike(req.query.q)}%`);
      i += 1;
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const totalRows = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM funnels f WHERE ${where.join(' AND ')}`,
      params
    );
    const rows = await pgQuery(
      `SELECT f.*,
              COALESCE(p.n, 0)::int AS pages_count
       FROM funnels f
       LEFT JOIN (
         SELECT funnel_id, COUNT(*) AS n
         FROM funnel_pages WHERE archived = FALSE GROUP BY funnel_id
       ) p ON p.funnel_id = f.id
       WHERE ${where.join(' AND ')}
       ORDER BY f.updated_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({
      success: true,
      data: {
        funnels: rows,
        total: totalRows[0].n,
        page,
        pages: Math.max(Math.ceil(totalRows[0].n / limit), 1),
      },
    });
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
      // Canonicalize: the serve gate reads the exact string 'published', but
      // the UI historically offered 'live' — which stored verbatim and then
      // 404ed publicly while the status pill showed green. 'live' IS
      // 'published'; anything outside the enum is refused, not stored.
      const raw = String(body.status).trim().toLowerCase();
      const status = raw === 'live' ? 'published' : raw;
      if (!['draft', 'published'].includes(status)) {
        return res.status(400).json({ error: "status must be 'draft' or 'published' ('live' is accepted as published)" });
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
      const seoErr = scanValue(body.seo, 0); // #8: same proto-key scan as blocks
      if (seoErr) return res.status(400).json({ error: `seo: ${seoErr}` });
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

// POST /api/v1/funnels/:id/publish — flips the funnel to status='published'.
// (Pages publish individually via PATCH status; this is the funnel-level gate.)
router.post('/:id/publish', async (req, res) => {
  try {
    await ensureTables();
    // Same posture as every other write in this file: no writes to a trashed
    // funnel — publishing from the archive silently resurrects it publicly.
    const rows = await pgQuery(
      `UPDATE funnels SET status = 'published', updated_at = NOW()
       WHERE id = $1 AND archived = FALSE RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Funnel not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[funnels] publish failed:', err);
    res.status(500).json({ error: 'Failed to publish funnel' });
  }
});

// PATCH /api/v1/funnels/:id/flow — persists the canvas layout into
// funnels.flow_layout. Shape: { nodes: [{id, x, y}], edges: [{source, target,
// kind}] }. Every node id and every edge endpoint MUST reference a live
// (non-archived) page of THIS funnel — an unknown id is rejected 400 so the
// canvas can never persist a dangling reference. Sizes are capped because this
// blob is read back and walked by the canvas on every open. Coordinates are
// coerced to finite numbers (NaN/Infinity rejected) — a poisoned x/y would
// otherwise crash React Flow at render time.
const FLOW_MAX_NODES = 1000;
const FLOW_MAX_EDGES = 2000;
const EDGE_KINDS = new Set(['main', 'fallback']);

function validateFlow(flow, validPageIds) {
  if (!isPlainObject(flow)) return { error: 'flow_layout must be an object' };
  const rawNodes = flow.nodes;
  const rawEdges = flow.edges;
  if (rawNodes !== undefined && !Array.isArray(rawNodes))
    return { error: 'flow_layout.nodes must be an array' };
  if (rawEdges !== undefined && !Array.isArray(rawEdges))
    return { error: 'flow_layout.edges must be an array' };
  const nodes = rawNodes || [];
  const edges = rawEdges || [];
  if (nodes.length > FLOW_MAX_NODES)
    return { error: `flow_layout.nodes cannot exceed ${FLOW_MAX_NODES} entries` };
  if (edges.length > FLOW_MAX_EDGES)
    return { error: `flow_layout.edges cannot exceed ${FLOW_MAX_EDGES} entries` };

  const cleanNodes = [];
  const seenNodeIds = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!isPlainObject(n)) return { error: `flow_layout.nodes[${i}] must be an object` };
    const id = String(n.id);
    if (!validPageIds.has(id))
      return { error: `flow_layout.nodes[${i}].id does not reference a page of this funnel` };
    if (seenNodeIds.has(id))
      return { error: `flow_layout.nodes[${i}].id is duplicated` };
    const x = Number(n.x);
    const y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return { error: `flow_layout.nodes[${i}] x/y must be finite numbers` };
    seenNodeIds.add(id);
    cleanNodes.push({ id, x, y });
  }

  const cleanEdges = [];
  const seenEdges = new Set();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!isPlainObject(e)) return { error: `flow_layout.edges[${i}] must be an object` };
    const source = String(e.source);
    const target = String(e.target);
    if (!validPageIds.has(source))
      return { error: `flow_layout.edges[${i}].source does not reference a page of this funnel` };
    if (!validPageIds.has(target))
      return { error: `flow_layout.edges[${i}].target does not reference a page of this funnel` };
    if (source === target)
      return { error: `flow_layout.edges[${i}] cannot connect a page to itself` }; // F2
    const kind = e.kind === undefined ? 'main' : String(e.kind);
    if (!EDGE_KINDS.has(kind))
      return { error: `flow_layout.edges[${i}].kind must be one of: ${[...EDGE_KINDS].join(', ')}` };
    const dedupeKey = `${source}|${target}|${kind}`; // F3: drop exact duplicates
    if (seenEdges.has(dedupeKey)) continue;
    seenEdges.add(dedupeKey);
    const edge = { source, target, kind };
    if (e.id !== undefined) edge.id = String(e.id).slice(0, 128);
    cleanEdges.push(edge);
  }

  return { value: { nodes: cleanNodes, edges: cleanEdges } };
}

router.patch('/:id/flow', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    if (funnel.archived) {
      // F1: consistent with the pages endpoints — no writes to a trashed funnel
      return res.status(400).json({ error: 'Funnel is archived — restore it before editing the flow' });
    }
    // F5: an empty body must not silently wipe the layout
    if (req.body?.nodes === undefined && req.body?.edges === undefined) {
      return res.status(400).json({ error: 'flow_layout requires nodes and/or edges' });
    }

    const pages = await pgQuery(
      `SELECT id FROM funnel_pages WHERE funnel_id = $1 AND archived = FALSE`,
      [req.params.id]
    );
    const validPageIds = new Set(pages.map((p) => p.id));

    const { error, value } = validateFlow(req.body || {}, validPageIds);
    if (error) return res.status(400).json({ error });

    const rows = await pgQuery(
      `UPDATE funnels SET flow_layout = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, value] // raw object — postgres.js serializes JSONB
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[funnels] flow update failed:', err);
    res.status(500).json({ error: 'Failed to save flow layout' });
  }
});

// ---------------------------------------------------------------------------
// Redirects (slice 4)
// ---------------------------------------------------------------------------

const REDIRECT_MATCHES = new Set(['exact', 'prefix']);
const REDIRECT_CODES = new Set([301, 302]);
// A path must be funnel-root relative: start with '/', no scheme/host, no
// whitespace, and no '?'/'#' — the query string is carried from the *request*
// at resolution time, so a stored query would double up. Length-capped.
const REDIRECT_PATH_RE = /^\/[^\s?#]*$/;
const REDIRECT_PATH_MAX = 2048;

function validatePath(label, value) {
  if (typeof value !== 'string') return `${label} must be a string`;
  const v = value.trim();
  if (!v.startsWith('/')) return `${label} must start with '/'`;
  // Reject protocol-relative ('//host') and backslash variants ('/\\host'):
  // browsers resolve those to an EXTERNAL origin → open-redirect vector.
  if (v.startsWith('//') || v.startsWith('/\\')) return `${label} must be a same-site path`;
  if (v.length > REDIRECT_PATH_MAX) return `${label} is too long`;
  if (!REDIRECT_PATH_RE.test(v))
    return `${label} must be a path (no protocol, host, query or fragment)`;
  return null;
}


// A redirect rule can take a whole funnel offline in two ways the path
// validators do not catch. Both are cheap to refuse at write time and
// impossible to diagnose from a browser redirect loop.
//   • from_path === to_path  → an infinite 30x on that path.
//   • from_path '/' + prefix → swallows EVERY path in the funnel.
function validateRedirectRule({ fromPath, toPath, match }) {
  if (String(fromPath) === String(toPath)) {
    return 'from_path and to_path are identical — that redirects to itself forever';
  }
  if (match === 'prefix' && String(fromPath) === '/') {
    return "a prefix rule on '/' would swallow every page in the funnel";
  }
  return null;
}

// Shared, pure resolver — exact beats longest-prefix; only enabled rows. A
// prefix rule matches its own path exactly OR any deeper segment ('/p' covers
// '/p' and '/p/x' but NOT '/products'). Exported so the public serving router
// applies IDENTICAL semantics. `reqPath` is the funnel-relative path WITHOUT
// query string. Returns the winning row or null.
export function pickRedirect(redirects, reqPath) {
  if (!Array.isArray(redirects) || !redirects.length) return null;
  let exact = null;
  let bestPrefix = null;
  for (const r of redirects) {
    if (!r || r.enabled === false) continue;
    const from = String(r.from_path || '');
    if (r.match === 'prefix') {
      const covers = reqPath === from || reqPath.startsWith(from.endsWith('/') ? from : `${from}/`);
      if (covers && (!bestPrefix || from.length > String(bestPrefix.from_path).length)) {
        bestPrefix = r;
      }
    } else {
      // treat any non-'prefix' match (default 'exact') as exact
      if (from === reqPath && !exact) exact = r;
    }
  }
  return exact || bestPrefix || null;
}

// Load enabled redirects for a funnel — used by the public serving router.
export async function getEnabledRedirects(funnelId) {
  return pgQuery(
    `SELECT * FROM funnel_redirects WHERE funnel_id = $1 AND enabled = TRUE
     ORDER BY created_at ASC`,
    [funnelId]
  );
}

// GET /api/v1/funnels/:id/redirects — all rows (enabled + disabled)
router.get('/:id/redirects', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    const rows = await pgQuery(
      `SELECT * FROM funnel_redirects WHERE funnel_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: { redirects: rows } });
  } catch (err) {
    console.error('[funnels] redirects list failed:', err);
    res.status(500).json({ error: 'Failed to load redirects' });
  }
});

// POST /api/v1/funnels/:id/redirects — { from_path, to_path, match?, code?, enabled? }
router.post('/:id/redirects', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    if (funnel.archived) {
      return res.status(400).json({ error: 'Funnel is archived — restore it before adding redirects' });
    }
    const body = req.body || {};
    const fromErr = validatePath('from_path', body.from_path);
    if (fromErr) return res.status(400).json({ error: fromErr });
    const toErr = validatePath('to_path', body.to_path);
    if (toErr) return res.status(400).json({ error: toErr });

    const match = body.match === undefined ? 'exact' : String(body.match);
    if (!REDIRECT_MATCHES.has(match))
      return res.status(400).json({ error: `match must be one of: ${[...REDIRECT_MATCHES].join(', ')}` });

    const ruleErr = validateRedirectRule({
      fromPath: body.from_path, toPath: body.to_path, match,
    });
    if (ruleErr) return res.status(400).json({ error: ruleErr });

    const code = body.code === undefined ? 301 : Number(body.code);
    if (!REDIRECT_CODES.has(code))
      return res.status(400).json({ error: 'code must be 301 or 302' });

    let enabled = true;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean')
        return res.status(400).json({ error: 'enabled must be a boolean' });
      enabled = body.enabled;
    }

    const id = genId('fr');
    const rows = await pgQuery(
      `INSERT INTO funnel_redirects (id, funnel_id, from_path, to_path, match, code, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, req.params.id, String(body.from_path).trim(), String(body.to_path).trim(), match, code, enabled]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[funnels] redirect create failed:', err);
    res.status(500).json({ error: 'Failed to create redirect' });
  }
});

// PATCH /api/v1/funnels/:id/redirects/:rid
router.patch('/:id/redirects/:rid', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    if (funnel.archived) {
      return res.status(400).json({ error: 'Funnel is archived — restore it before editing redirects' });
    }
    const existing = await pgQuery(
      `SELECT id FROM funnel_redirects WHERE id = $1 AND funnel_id = $2`,
      [req.params.rid, req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Redirect not found' });

    const body = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;

    if (body.from_path !== undefined) {
      const err = validatePath('from_path', body.from_path);
      if (err) return res.status(400).json({ error: err });
      sets.push(`from_path = $${i}`);
      params.push(String(body.from_path).trim());
      i += 1;
    }
    if (body.to_path !== undefined) {
      const err = validatePath('to_path', body.to_path);
      if (err) return res.status(400).json({ error: err });
      sets.push(`to_path = $${i}`);
      params.push(String(body.to_path).trim());
      i += 1;
    }
    if (body.match !== undefined) {
      const match = String(body.match);
      if (!REDIRECT_MATCHES.has(match))
        return res.status(400).json({ error: `match must be one of: ${[...REDIRECT_MATCHES].join(', ')}` });
      sets.push(`match = $${i}`);
      params.push(match);
      i += 1;
    }
    if (body.code !== undefined) {
      const code = Number(body.code);
      if (!REDIRECT_CODES.has(code))
        return res.status(400).json({ error: 'code must be 301 or 302' });
      sets.push(`code = $${i}`);
      params.push(code);
      i += 1;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean')
        return res.status(400).json({ error: 'enabled must be a boolean' });
      sets.push(`enabled = $${i}`);
      params.push(body.enabled);
      i += 1;
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.rid, req.params.id);
    const rows = await pgQuery(
      `UPDATE funnel_redirects SET ${sets.join(', ')}
       WHERE id = $${i} AND funnel_id = $${i + 1} RETURNING *`,
      params
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[funnels] redirect update failed:', err);
    res.status(500).json({ error: 'Failed to update redirect' });
  }
});

// DELETE /api/v1/funnels/:id/redirects/:rid — redirects are cheap config, so
// this is a hard delete (unlike pages/funnels, which archive).
router.delete('/:id/redirects/:rid', async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `DELETE FROM funnel_redirects WHERE id = $1 AND funnel_id = $2 RETURNING id`,
      [req.params.rid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Redirect not found' });
    res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[funnels] redirect delete failed:', err);
    res.status(500).json({ error: 'Failed to delete redirect' });
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
    if (funnel.archived) {
      return res.status(400).json({ error: 'Funnel is archived — restore it before adding pages' });
    }

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

    // CHECKOUT-TEMPLATE: a new 'checkout' page starts from the default styled
    // template (two-column layout replicating the live checkout — see
    // docs/CHECKOUT-TEMPLATE-SPEC.md) instead of an empty canvas. Fail-open:
    // if the seed cannot be built or does not validate, the page is created
    // empty exactly as before — template trouble must never block page create.
    let seed = null;
    const seedTemplate = PAGE_SEED_TEMPLATES[type];
    if (seedTemplate) {
      try {
        const tpl = seedTemplate();
        const seedErr = validateBlocks(tpl.blocks);
        if (seedErr) {
          console.error(`[funnels] ${type} template seed invalid (fail-open):`, seedErr);
        } else {
          seed = tpl;
        }
      } catch (err) {
        console.error(`[funnels] ${type} template seed failed (fail-open):`, err.message);
      }
    }

    const id = genId('fpg');
    const rows = seed
      ? await pgQuery(
          `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, is_home, blocks, custom_css, custom_js)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [id, req.params.id, slug, type, title, isHome, seed.blocks, seed.custom_css, seed.custom_js]
        )
      : await pgQuery(
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
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    if (funnel.archived) {
      return res.status(400).json({ error: 'Funnel is archived — restore it before editing pages' });
    }
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
      // Canonicalize: the serve gate reads the exact string 'published', but
      // the UI historically offered 'live' — which stored verbatim and then
      // 404ed publicly while the status pill showed green. 'live' IS
      // 'published'; anything outside the enum is refused, not stored.
      const raw = String(body.status).trim().toLowerCase();
      const status = raw === 'live' ? 'published' : raw;
      if (!['draft', 'published'].includes(status)) {
        return res.status(400).json({ error: "status must be 'draft' or 'published' ('live' is accepted as published)" });
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
      const seoErr = scanValue(body.seo, 0); // #8: same proto-key scan as blocks
      if (seoErr) return res.status(400).json({ error: `seo: ${seoErr}` });
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
    if (body.is_home === true && pageRows[0].archived) {
      // The exactly-one-home flip below filters archived=FALSE: an archived
      // target would clear every live sibling's flag while never gaining its
      // own — leaving the funnel with no home page at all. Refuse instead.
      return res.status(400).json({ error: 'Cannot set an archived page as home — restore it first' });
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
    // Un-homing the current home must not orphan the funnel: promote the
    // oldest live sibling so exactly-one-home survives (review finding #1).
    if (body.is_home === false) {
      await ensureHomeInvariant(req.params.id);
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

// GET /api/v1/funnels/:id/pages/:pageId/preview-url — where does this page
// serve publicly? `preview: true` means the page (or funnel) is not published
// yet, so the viewer must append ?preview=1 + a Bearer token to see it.
router.get('/:id/pages/:pageId/preview-url', async (req, res) => {
  try {
    await ensureTables();
    const funnel = await getFunnel(req.params.id);
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    const pages = await pgQuery(
      `SELECT * FROM funnel_pages WHERE id = $1 AND funnel_id = $2`,
      [req.params.pageId, req.params.id]
    );
    const page = pages[0];
    if (!page) return res.status(404).json({ error: 'Page not found' });
    // Page slugs are stored as '/' or '/foo' — '/' maps to the funnel root.
    const suffix = page.slug === '/' ? '' : page.slug;
    const path = `/f/${funnel.slug}${suffix}`;
    const preview = page.status !== 'published' || page.archived === true;
    res.json({ success: true, data: { path, preview } });
  } catch (err) {
    console.error('[funnels] preview-url failed:', err);
    res.status(500).json({ error: 'Failed to build preview URL' });
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
    if (archived) {
      // Review findings #1/#4: archiving the home page must promote a live
      // sibling, and a default_page_id pointing at the archived page must not
      // dangle. Both are repair operations — fail-open, never block the archive.
      try {
        await ensureHomeInvariant(req.params.id);
        await pgQuery(
          `UPDATE funnels SET default_page_id = NULL, updated_at = NOW()
           WHERE id = $1 AND default_page_id = $2`,
          [req.params.id, req.params.pageId]
        );
        // F4: prune the archived page's node + any incident edges from
        // flow_layout so the canvas never carries a dangling reference (which
        // would otherwise wedge the next autosave at "Save failed").
        const f = await pgQuery(`SELECT flow_layout FROM funnels WHERE id = $1`, [req.params.id]);
        const fl = f[0]?.flow_layout;
        if (fl && (Array.isArray(fl.nodes) || Array.isArray(fl.edges))) {
          const pid = req.params.pageId;
          const pruned = {
            nodes: (fl.nodes || []).filter((n) => n.id !== pid),
            edges: (fl.edges || []).filter((e) => e.source !== pid && e.target !== pid),
          };
          await pgQuery(
            `UPDATE funnels SET flow_layout = $2, updated_at = NOW() WHERE id = $1`,
            [req.params.id, pruned]
          );
        }
      } catch (repairErr) {
        console.error('[funnels] post-archive repair failed:', repairErr.message);
      }
    }
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
