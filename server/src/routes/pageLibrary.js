// PAGE LIBRARY ROUTES — save a funnel page as a reusable snapshot, browse the
// saved set, clone one into ANY funnel.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE REFERENCE TOOL ACTUALLY DOES (read the code, not the caption)
//
// funnel-os's "Page library" (PageLibraryPanel.jsx) is NOT a saved library. It
// is a read-only flyout that lists the CURRENT funnel's own lb_pages rows,
// grouped by normalized type, and drag-to-canvas calls the generic
// POST /pages/{pid}/clone. There is no library table, no save action, and its
// "45 pages · drag to clone" caption is just `pages.length` for the funnel on
// screen. Its ONE cross-funnel affordance is POST /pages/{pid}/share, buried in
// the page settings drawer, and its lb_templates collection is 11 seeded system
// rows with NO write endpoint at all (the router advertises "save as template";
// the route does not exist).
//
// This port keeps that flyout faithfully (client side — "This funnel" tab, same
// type bands, same drag-to-clone) and adds what his tool advertises but never
// built: a PERSISTED library that survives the funnel it came from. Everything
// in THIS file is that addition. Four of his decisions are reversed on purpose:
//
//   1. His clone slug counter starts at `count_documents(...) + 1` INCLUDING
//      archived rows, over a base that may already end in `-copy-N`, so repeat
//      clones compound into `/checkout-copy-3-copy-7`. This port derives the
//      base from the requested title and walks a plain `-2`, `-3` ladder over
//      LIVE slugs only — the same ladder pageClone.js already uses.
//   2. His library is funnel-scoped and evaporates when the funnel is deleted.
//      This port's entries are SNAPSHOTS with no FK to the source (see
//      pageLibrarySchema.js) — deleting the source funnel does not touch them.
//   3. His browse endpoints are hard-capped at `to_list(200)` with no
//      pagination and no total, so a big workspace silently under-counts. This
//      port returns an explicit `total` alongside the page and refuses a save
//      past LIBRARY_MAX_ENTRIES rather than truncating a read.
//   4. His `lb_templates.find_one({"id": ...})` has no workspace filter, so a
//      template id from another workspace resolves. This deployment is
//      single-tenant, so there is no equivalent hole to inherit — but every
//      read here is still pinned by an explicit predicate rather than by id
//      alone, and the SAVE path is pinned to (page_id, funnel_id, NOT archived)
//      so a page id from another funnel copies NOTHING.
//
// ─────────────────────────────────────────────────────────────────────────────
// MONEY BLOCKS
//
// A library entry carries `blocks` VERBATIM, including the commerce blocks
// (whop_checkout, order_summary, order_bump, shipping_method, product,
// upsell_offer, ...) with every prop intact — a checkout page saved with its
// variant ids and bump configuration clones back as the same checkout page.
// That is safe because a block's props are NOT a price: the public
// create-session path re-resolves every variant against the Shopify Admin API
// and charges the SHOPIFY price (services/checkoutPricing.js — "the public
// create-session endpoint must NEVER trust a client-sent price", fail-closed on
// transport error, never a fallback to a client value). A stale price sitting
// in a year-old library entry therefore cannot be charged; at worst it renders
// and is corrected at checkout.
//
// The clone still lands as status='draft' regardless, so a money page never
// starts serving publicly as a side effect of a drag onto a canvas.
// ─────────────────────────────────────────────────────────────────────────────
//
// Auth is the sibling posture exactly (funnels.js:23, pageClone.js,
// funnelTransfer.js): authenticate + requirePermission('funnels', 'access').
// Every endpoint is an operator surface; nothing here is public.
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { client, pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
// funnels.js is READ-ONLY for this lane — both imports, no edits.
import { ensureTables, validateBlocks } from './funnels.js';
import {
  ensurePageLibraryTables,
  LIBRARY_LIST_COLUMNS,
  NAME_MAX,
  DESCRIPTION_MAX,
  CATEGORY_MAX,
  LIBRARY_MAX_ENTRIES,
  LIBRARY_CAPACITY_LOCK_KEY,
  TX_STATEMENT_TIMEOUT_MS,
  SLUG_BASE_MAX,
  DEFAULT_CATEGORY,
} from '../services/pageLibrarySchema.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const PAGE_SLUG_RE = /^\/$|^\/[a-z0-9-]+$/;
const UNIQUE_VIOLATION = '23505';
const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 200;
// Bounded retries for a DERIVED slug that lost a race to a writer which does
// NOT take our funnel lock (funnels.js POST /pages and its duplicate endpoint
// both insert unlocked). Bounded, and the last failure is a 409 — never an
// uncaught 23505 escaping as a 500.
const SLUG_RETRY_ATTEMPTS = 3;

const genId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`;

// Escape LIKE metacharacters so ?q=% cannot act as a wildcard. Same helper as
// funnels.js:265 / customers.js / orders.js — copied rather than imported
// because funnels.js does not export it and this lane may not edit it.
const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

// Slug body, capped at SLUG_BASE_MAX so that appending a '-N' ladder step or a
// '-<4 hex>' retry suffix still fits the budget. Trailing dashes are re-stripped
// AFTER the slice: the strip in the general slugify runs before its own slice,
// so cutting mid-word can expose a new trailing '-' and yield '/foo--a1b2'.
const slugBase = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/g, '');

// Roll back a transaction while carrying a structured outcome back out.
// postgres.js commits unless the callback throws, so an in-transaction refusal
// has to travel as a throw or it would COMMIT the very write it is refusing.
class TxAbort extends Error {
  constructor(result) {
    super('tx_abort');
    this.name = 'TxAbort';
    this.result = result;
  }
}

// Run a transaction that may abort with a structured outcome. Any other error
// propagates untouched — a real fault must never be mistaken for a refusal.
async function runTx(fn) {
  try {
    return await client.begin(async (tx) => {
      // review m5: bound the transaction on the same clock as pgQuery (8s)
      // rather than inheriting the 15s connection-level cap. SET LOCAL reverts
      // at transaction end and never leaks onto the pooled connection.
      await tx.unsafe(`SET LOCAL statement_timeout = ${TX_STATEMENT_TIMEOUT_MS}`);
      return await fn(tx);
    });
  } catch (err) {
    if (err instanceof TxAbort) return err.result;
    throw err;
  }
}

// Structured errors, matching splitTests.js / funnelTransfer.js.
const fail = (res, status, code, detail) =>
  res.status(status).json({ success: false, error: detail ? { code, detail } : { code } });

// Trim + cap a free-text metadata field. Returns { value } or { error }.
// A field that is present but not a string is a CLIENT BUG, not an empty
// field — it 400s rather than being coerced to "[object Object]".
function readText(body, key, max, { required = false } = {}) {
  const raw = body?.[key];
  if (raw === undefined || raw === null) {
    if (required) return { error: `${key}_is_required` };
    return { value: '' };
  }
  if (typeof raw !== 'string') return { error: `${key}_must_be_a_string` };
  const trimmed = raw.trim();
  if (required && !trimmed) return { error: `${key}_is_required` };
  if (Buffer.byteLength(trimmed, 'utf8') > max) return { error: `${key}_exceeds_${max}_bytes` };
  return { value: trimmed };
}

// ---------------------------------------------------------------------------
// GET /api/v1/page-library
//   ?q= &type= &category= &limit= &offset=
//
// Metadata only (LIBRARY_LIST_COLUMNS) — never `blocks`. `total` is the count
// under the SAME filters, so the flyout can say "showing 100 of 240" instead of
// silently truncating the way funnel-os's to_list(200) does.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    await ensurePageLibraryTables();

    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, NAME_MAX) : '';
    const type = typeof req.query.type === 'string' ? req.query.type.trim().slice(0, 40) : '';
    const category =
      typeof req.query.category === 'string' ? req.query.category.trim().slice(0, CATEGORY_MAX) : '';

    // Number('') is 0 and Number(undefined) is NaN — neither may become a
    // silently different page than the caller asked for, so both fall back to
    // the default rather than to 0.
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), LIST_LIMIT_MAX)
      : LIST_LIMIT_DEFAULT;
    const rawOffset = Number.parseInt(req.query.offset, 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // ONE predicate string, used by both the page read and the count, so the
    // two can never disagree about what is being counted.
    const where = [`archived = FALSE`];
    const params = [];
    if (q) {
      // review m2: a raw q let '%' and '_' act as wildcards — searching for a
      // literal '%' matched EVERY entry. escapeLike backslash-escapes the
      // metacharacters and the explicit ESCAPE '\' names the escape character
      // rather than relying on the (backslash) default.
      params.push(`%${escapeLike(q)}%`);
      where.push(
        `(name ILIKE $${params.length} ESCAPE '\\' OR description ILIKE $${params.length} ESCAPE '\\')`
      );
    }
    if (type) {
      params.push(type);
      where.push(`type = $${params.length}`);
    }
    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    const whereSql = where.join(' AND ');

    const rows = await pgQuery(
      `SELECT ${LIBRARY_LIST_COLUMNS}
         FROM funnel_page_library
        WHERE ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const totals = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE ${whereSql}`,
      params
    );

    // Facets come from the UNFILTERED live set, not from `rows`: pills built
    // out of the current page would vanish the moment a filter excluded their
    // last row, leaving the operator with no way back.
    const facets = await pgQuery(
      `SELECT category, type, COUNT(*)::int AS n
         FROM funnel_page_library
        WHERE archived = FALSE
        GROUP BY category, type`
    );
    const byCategory = new Map();
    const byType = new Map();
    for (const f of facets) {
      byCategory.set(f.category, (byCategory.get(f.category) || 0) + f.n);
      byType.set(f.type, (byType.get(f.type) || 0) + f.n);
    }

    return res.json({
      success: true,
      data: {
        entries: rows,
        total: totals[0]?.n ?? 0,
        limit,
        offset,
        categories: [...byCategory.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        types: [...byType.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      },
    });
  } catch (err) {
    console.error('[page-library] list failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/page-library/:entryId — the FULL entry, blocks included.
// The only endpoint that ships block content; the editor uses it to preview an
// entry before cloning.
// ---------------------------------------------------------------------------
router.get('/:entryId', async (req, res) => {
  try {
    await ensurePageLibraryTables();
    const rows = await pgQuery(
      `SELECT * FROM funnel_page_library WHERE id = $1 AND archived = FALSE`,
      [String(req.params.entryId || '')]
    );
    if (!rows.length) return fail(res, 404, 'entry_not_found');
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[page-library] get failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/page-library
//   { funnel_id, page_id, name?, description?, category? }
//
// Save a funnel page INTO the library. The copy is ONE INSERT…SELECT — a single
// statement, so a single implicit transaction — for the same reason funnels.js
// gives its duplicate endpoint: a read-into-JS-then-write leaves a window in
// which a concurrent PATCH makes the "snapshot" describe a state that never
// existed as a whole.
//
// The SELECT is pinned to (id, funnel_id, NOT archived): a page id belonging to
// ANOTHER funnel copies nothing and 404s, so this route can never be used to
// read a page across the funnel boundary.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    await ensurePageLibraryTables();
    const body = req.body || {};

    const funnelId = String(body.funnel_id || '').trim();
    const pageId = String(body.page_id || '').trim();
    if (!funnelId) return fail(res, 400, 'funnel_id_is_required');
    if (!pageId) return fail(res, 400, 'page_id_is_required');

    const description = readText(body, 'description', DESCRIPTION_MAX);
    if (description.error) return fail(res, 400, description.error);
    const category = readText(body, 'category', CATEGORY_MAX);
    if (category.error) return fail(res, 400, category.error);
    // `name` is optional on the wire and falls back to the page's own title in
    // SQL (COALESCE below) — an operator who hits Save without typing anything
    // gets an entry named after the page, not an entry named ''.
    const nameField = readText(body, 'name', NAME_MAX);
    if (nameField.error) return fail(res, 400, nameField.error);
    const name = nameField.value || null;

    // ⚠️ Content column list #1 of 2 (the clone below is #2). A new content
    // column on funnel_pages must be added to BOTH or the library silently
    // drops it.
    const INSERT_SQL = `
      INSERT INTO funnel_page_library
        (id, name, description, category, type,
         blocks, seo, custom_html, custom_css, custom_js, head_html, body_end_html,
         source_funnel_id, source_page_id, source_title, created_by)
      SELECT $1::text,
             COALESCE($2::text, NULLIF(TRIM(title), ''), 'Untitled page'),
             $3::text,
             COALESCE(NULLIF($4::text, ''), $7::text),
             type,
             blocks, seo, custom_html, custom_css, custom_js, head_html, body_end_html,
             funnel_id, id, title, $5::text
        FROM funnel_pages
       WHERE id = $6::text AND funnel_id = $8::text AND NOT archived
      RETURNING *`;

    // review m1: the capacity gate and the copy run in ONE transaction behind a
    // transaction-scoped advisory lock. A bare count-then-insert measured
    // 501/500 under three concurrent saves — every saver read N-1 from its own
    // snapshot. Folding the count into the INSERT…SELECT as a subquery would
    // NOT have fixed it (same snapshot); serializing is the only thing that
    // does. The lock is released by COMMIT/ROLLBACK, including the abort paths.
    const outcome = await runTx(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LIBRARY_CAPACITY_LOCK_KEY}::bigint)`;

      const live = await tx`
        SELECT COUNT(*)::int AS n FROM funnel_page_library WHERE archived = FALSE`;
      if ((live[0]?.n ?? 0) >= LIBRARY_MAX_ENTRIES) throw new TxAbort({ full: true });

      const rows = await tx.unsafe(INSERT_SQL, [
        genId('fpl'),
        name,
        description.value,
        category.value,
        req.user?.id ?? null,
        pageId,
        DEFAULT_CATEGORY,
        funnelId,
      ]);
      if (!rows.length) throw new TxAbort({ missing: true });

      // The saved blocks came out of funnel_pages, which validates on WRITE —
      // so this should never fire. It is here because "should never" is a claim
      // about today's write paths, and an entry that fails validation is one
      // the clone endpoint would refuse to instantiate later, silently, from
      // the operator's point of view. Better to know at save time.
      //
      // The refusal now travels as a TxAbort so the INSERT is ROLLED BACK
      // rather than committed-then-deleted: the old compensating DELETE left a
      // window in which a concurrent list could see an entry that was about to
      // be rejected.
      const blocksError = validateBlocks(rows[0].blocks);
      if (blocksError) throw new TxAbort({ blocksError });

      return { rows };
    });

    if (outcome.full) {
      return fail(
        res,
        409,
        'library_is_full',
        `the library holds the maximum of ${LIBRARY_MAX_ENTRIES} entries — delete one before saving another`
      );
    }
    if (outcome.missing) return fail(res, 404, 'page_not_found');
    if (outcome.blocksError) {
      return fail(res, 422, 'source_page_blocks_are_invalid', outcome.blocksError);
    }

    return res.status(201).json({ success: true, data: outcome.rows[0] });
  } catch (err) {
    console.error('[page-library] save failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/page-library/:entryId — { name?, description?, category? }
//
// METADATA ONLY, and that is a decision, not an omission: an entry is a
// SNAPSHOT. Letting content be edited in place would silently change what every
// future clone produces while the operator believes they renamed a card. To
// change content, save a new entry from an edited page.
// ---------------------------------------------------------------------------
router.patch('/:entryId', async (req, res) => {
  try {
    await ensurePageLibraryTables();
    const body = req.body || {};

    const sets = [];
    const params = [];
    if (body.name !== undefined) {
      const f = readText(body, 'name', NAME_MAX, { required: true });
      if (f.error) return fail(res, 400, f.error);
      params.push(f.value);
      sets.push(`name = $${params.length}`);
    }
    if (body.description !== undefined) {
      const f = readText(body, 'description', DESCRIPTION_MAX);
      if (f.error) return fail(res, 400, f.error);
      params.push(f.value);
      sets.push(`description = $${params.length}`);
    }
    if (body.category !== undefined) {
      const f = readText(body, 'category', CATEGORY_MAX);
      if (f.error) return fail(res, 400, f.error);
      // A cleared category returns to the shared default bucket rather than
      // becoming a second, empty-named pill.
      params.push(f.value || DEFAULT_CATEGORY);
      sets.push(`category = $${params.length}`);
    }
    if (!sets.length) return fail(res, 400, 'nothing_to_update');

    params.push(String(req.params.entryId || ''));
    const rows = await pgQuery(
      `UPDATE funnel_page_library
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} AND archived = FALSE
        RETURNING *`,
      params
    );
    if (!rows.length) return fail(res, 404, 'entry_not_found');
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[page-library] update failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/page-library/:entryId — SOFT archive, matching every other
// delete in this codebase (funnels, pages, redirects). The content stays on
// disk; the flyout stops listing it and the slot is freed.
//
// ARCHIVED ROWS ARE NEVER RECLAIMED, and that is DELIBERATE (review nit) — but
// it is a real, bounded liability worth naming rather than discovering:
// LIBRARY_MAX_ENTRIES caps only the LIVE set, so an operator who repeatedly
// saves and deletes 2MB checkout pages grows this table without limit. No
// sweep is added here because a page library is exactly the kind of thing
// someone deletes and then wants back, and a hard delete is unrecoverable while
// a fat table is merely expensive. If the table does become a problem the fix
// is a sweep that hard-deletes rows with archived = TRUE older than N days —
// deliberately NOT wired up today, so that "it grows" is a decision on the
// record rather than an oversight found later.
// ---------------------------------------------------------------------------
router.delete('/:entryId', async (req, res) => {
  try {
    await ensurePageLibraryTables();
    const rows = await pgQuery(
      `UPDATE funnel_page_library
          SET archived = TRUE, updated_at = NOW()
        WHERE id = $1 AND archived = FALSE
        RETURNING id`,
      [String(req.params.entryId || '')]
    );
    if (!rows.length) return fail(res, 404, 'entry_not_found');
    return res.json({ success: true, data: { id: rows[0].id, archived: true } });
  } catch (err) {
    console.error('[page-library] delete failed:', err);
    return fail(res, 500, 'server_error');
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/page-library/:entryId/clone — { funnel_id, title?, slug? }
//
// Instantiate a library entry as a NEW page in ANY funnel. Always a DRAFT.
//
// SLUG POSTURE — funnel-transfer's exactly, both halves:
//   • DERIVED slug (no `slug` in the body): slugBase(title || entry.name), then
//     a `-2`, `-3` ladder over the funnel's LIVE slugs. Never a silent
//     overwrite; the response reports the slug that was actually taken.
//   • PINNED slug (caller sent one): a collision is REFUSED with prose (409),
//     never rewritten. That collision is the caller's to read — the same split
//     funnels.js draws on its duplicate endpoint.
//
// is_home is decided by the DATABASE inside the insert (pageClone.js's
// posture): a clone into an EMPTY funnel becomes home so the funnel is not
// born unreachable, and a clone into a funnel that already has one can never
// steal the slot. The transaction takes a row lock on the parent funnel first
// because the conditional subquery alone is not enough under READ COMMITTED —
// two concurrent first-page clones would both read "empty".
// ---------------------------------------------------------------------------
router.post('/:entryId/clone', async (req, res) => {
  try {
    await ensureTables();
    await ensurePageLibraryTables();
    const body = req.body || {};

    const funnelId = String(body.funnel_id || '').trim();
    if (!funnelId) return fail(res, 400, 'funnel_id_is_required');

    const entryRows = await pgQuery(
      `SELECT * FROM funnel_page_library WHERE id = $1 AND archived = FALSE`,
      [String(req.params.entryId || '')]
    );
    const entry = entryRows[0];
    if (!entry) return fail(res, 404, 'entry_not_found');

    const funnelRows = await pgQuery(`SELECT id, archived FROM funnels WHERE id = $1`, [funnelId]);
    const funnel = funnelRows[0];
    if (!funnel) return fail(res, 404, 'funnel_not_found');
    if (funnel.archived) {
      return fail(
        res,
        400,
        'funnel_is_archived',
        'restore the funnel before cloning pages into it'
      );
    }

    const titleField = readText(body, 'title', NAME_MAX);
    if (titleField.error) return fail(res, 400, titleField.error);
    const title = titleField.value || entry.name;

    // The entry's content is re-validated on the way OUT as well as in. An
    // entry written before a cap tightened, or by a future path that skips the
    // save route, must not be able to plant blocks the public renderer will
    // choke on — the write is the defense, and a clone IS a write.
    const blocksError = validateBlocks(entry.blocks);
    if (blocksError) {
      const isSize = /2MB|exceed/i.test(blocksError);
      return fail(res, isSize ? 413 : 422, 'entry_blocks_are_invalid', blocksError);
    }

    let pinned = null;
    if (body.slug !== undefined && body.slug !== null) {
      if (typeof body.slug !== 'string') return fail(res, 400, 'slug_must_be_a_string');
      pinned = body.slug.trim();
      if (!PAGE_SLUG_RE.test(pinned)) {
        return fail(
          res,
          400,
          'slug_is_invalid',
          "slug must be '/' or '/' followed by lowercase letters, numbers and dashes"
        );
      }
    }

    // The slug base, capped so every derived form fits the budget BY
    // CONSTRUCTION (see SLUG_BASE_MAX). Falls back to the page type, then to
    // 'page', so a title of pure punctuation still yields a legal slug.
    const base = slugBase(title) || slugBase(entry.type) || 'page';

    // ⚠️ Content column list #2 of 2 (the save above is #1).
    const INSERT_SQL = `
      INSERT INTO funnel_pages
        (id, funnel_id, slug, type, title, status, is_home,
         blocks, seo, custom_html, custom_css, custom_js, head_html, body_end_html)
      SELECT $1::text, $2::text, $3::text, type, $4::text, 'draft',
             NOT EXISTS (SELECT 1 FROM funnel_pages
                          WHERE funnel_id = $2::text AND archived = FALSE AND is_home = TRUE),
             blocks, seo, custom_html, custom_css, custom_js, head_html, body_end_html
        FROM funnel_page_library
       WHERE id = $5::text AND archived = FALSE
      RETURNING *`;

    // ONE transaction does all of it: lock the funnel, RE-CHECK that it is
    // still live, resolve the slug, insert.
    //
    // review M1 / m3 — three things moved inside the lock:
    //   • the ladder read. It used to run BEFORE the transaction, so the window
    //     between "these slugs are taken" and the INSERT was wide open. Inside
    //     the FOR UPDATE it is closed against every other clone into this
    //     funnel, because they all serialize on the same funnel row.
    //   • the archived re-check. The pre-flight SELECT above is advisory only;
    //     `AND archived = FALSE` on the LOCKED select means a funnel archived
    //     in between yields zero rows and the same 400 the pre-flight gives.
    //   • the retry. `attempt` is threaded in so a losing race re-reads the
    //     ladder under a freshly acquired lock instead of reusing a stale set.
    const attemptInsert = (attempt) =>
      runTx(async (tx) => {
        const locked = await tx`
          SELECT id FROM funnels WHERE id = ${funnelId} AND archived = FALSE FOR UPDATE`;
        if (!locked.length) throw new TxAbort({ archivedFunnel: true });

        let chosen = pinned;
        if (chosen === null) {
          if (attempt === 0) {
            const existing = await tx`
              SELECT slug FROM funnel_pages
               WHERE funnel_id = ${funnelId} AND archived = FALSE`;
            const taken = new Set(existing.map((r) => r.slug));
            chosen = `/${base}`;
            for (let n = 2; taken.has(chosen); n += 1) chosen = `/${base}-${n}`;
          } else {
            // A retry means an UNLOCKED writer (funnels.js POST /pages, or its
            // duplicate endpoint) took the slug between our ladder and our
            // insert. A random suffix converges faster than re-walking a ladder
            // against a writer that is still moving. The base already reserves
            // room for it, so the suffix cannot be truncated away — which is
            // exactly the bug that made the old retry re-submit the SAME slug
            // and let the second 23505 escape as a 500.
            chosen = `/${base}-${randomBytes(2).toString('hex')}`;
          }
          if (!PAGE_SLUG_RE.test(chosen)) throw new TxAbort({ badSlug: true });
        }

        const rows = await tx.unsafe(INSERT_SQL, [
          genId('fpg'), funnelId, chosen, title, entry.id,
        ]);
        // Zero rows means the entry was archived between the pre-flight read
        // and this insert. A 2xx carrying no page would push a ghost node onto
        // the canvas.
        if (!rows.length) throw new TxAbort({ entryGone: true });
        return { rows, chosen };
      });

    let outcome = null;
    let lastConflict = null;
    for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt += 1) {
      try {
        outcome = await attemptInsert(attempt);
        break;
      } catch (err) {
        if (err?.code !== UNIQUE_VIOLATION) throw err;
        lastConflict = err;
        // A PINNED slug is never rewritten — that collision is the caller's to
        // read, and retrying it would only produce the same violation.
        if (pinned !== null) {
          return fail(
            res,
            409,
            'slug_already_exists',
            `the funnel already has a page at ${pinned} — choose another slug`
          );
        }
      }
    }

    // Every attempt lost the race. That is a conflict, not a server fault —
    // answering 500 here (which the old single un-wrapped retry did) told the
    // operator the server was broken when the honest answer is "try again".
    if (!outcome) {
      console.warn(
        '[page-library] clone exhausted %d slug attempts for funnel %s (last code %s)',
        SLUG_RETRY_ATTEMPTS, funnelId, lastConflict?.code
      );
      return fail(
        res,
        409,
        'slug_already_exists',
        'could not find a free slug in this funnel — retry, or pass an explicit slug'
      );
    }

    if (outcome.archivedFunnel) {
      return fail(res, 400, 'funnel_is_archived', 'restore the funnel before cloning pages into it');
    }
    if (outcome.entryGone) return fail(res, 404, 'entry_not_found');
    if (outcome.badSlug) {
      return fail(
        res,
        422,
        'slug_could_not_be_derived',
        'could not derive a valid slug from that title — pass an explicit slug'
      );
    }

    return res.status(201).json({
      success: true,
      data: outcome.rows[0],
      // `slug_rewritten` compares against the slug the FIRST attempt would have
      // produced, so a retry suffix reads as a rewrite — which it is.
      meta: {
        library_entry_id: entry.id,
        slug_rewritten: outcome.rows[0].slug !== (pinned ?? `/${base}`),
      },
    });
  } catch (err) {
    console.error('[page-library] clone failed:', err);
    return fail(res, 500, 'server_error');
  }
});

export default router;
