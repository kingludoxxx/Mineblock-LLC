// AI DEVELOPER — persisted chat thread (SCHEMA OWNER, self-contained new file).
//
// TWO tables:
//   lb_ai_dev_chats   — an append-only, per-(page, funnel) transcript of the AI
//                       Developer conversation, ONE ROW PER MESSAGE.
//   lb_ai_dev_threads — one row per (page, funnel) carrying an EPOCH counter.
//                       It is the serialization point; see below.
//
// WHY ONE ROW PER MESSAGE rather than one row holding a jsonb array. The bound
// ("keep the last 50") is then a DELETE with an ORDER BY in the same transaction
// as the INSERT, and there is no read-modify-write window in which two
// concurrent turns each append to a stale copy of an array and lose one. (The
// reference tool stores a single Mongo doc with an embedded array and accepts
// that race.)
//
// THE EPOCH ROW, and why a counter earns its own table.
//
// Two defects share one cause — an append that does not coordinate with anything
// else touching the thread:
//
//   1. A DELETE issued WHILE a turn is streaming was silently undone. The turn
//      persists after the reply is computed, so the sequence "start turn →
//      operator clears the thread → turn finishes" left the cleared thread
//      repopulated with the very turn the operator had just discarded. Clearing
//      a conversation must WIN over a turn that was already in flight.
//   2. The prune was only as exact as the concurrency allowed. Two appends
//      racing could each see ≤50 rows and each insert, momentarily leaving more
//      than the bound on disk.
//
// Both are fixed by the same lock. Every append takes `SELECT … FOR UPDATE` on
// this thread's epoch row BEFORE inserting, so:
//   • appends to one thread SERIALIZE — the prune therefore sees the true row
//     count and the bound is EXACT, not eventual (asserted under real
//     concurrency in thread-routes.mjs);
//   • a DELETE bumps the epoch under the same lock, and an append whose epoch no
//     longer matches the one it started with writes NOTHING and reports 0.
// The route ensures the epoch row EXISTS at the start of a turn, so there is
// always something to lock — a `FOR UPDATE` that matches no row locks nothing,
// which is precisely the window that would let a concurrent DELETE slip past.
//
// ⛔ WHAT IS NEVER STORED: image BYTES. Pasted screenshots are pass-through
// only — they ride into the Anthropic request and are never written to this
// table, to disk, or anywhere else. A stored user message carries an
// `image_count` so the panel can render "2 screenshots" on a rehydrated turn,
// and nothing more. This is a DELIBERATE DIVERGENCE from the reference, which
// uploads operator screenshots to object storage and persists their URLs.
//
// DECISION MADE — RETENTION / ARCHIVAL ORPHANS. There is no FK to funnel_pages
// and no cascade: when a page is archived or hard-deleted, its thread rows STAY.
// Deliberate, and the conservative choice of the two:
//   • archiving is reversible in this product, and a restored page getting its
//     conversation back is the behaviour an operator expects;
//   • a cascade would make a page delete silently destroy history, and this
//     module owns no code path that deletes pages, so it would be inheriting a
//     destructive edge it cannot test;
//   • the rows are bounded at 50 per thread and hold no image bytes, so the
//     orphan cost is a few KB per dead page, not unbounded growth.
// The consequence, stated plainly: orphaned threads accumulate slowly and are
// unreachable through the API (every verb resolves a LIVE page first). If that
// ever needs reclaiming it is a sweep over pages that no longer exist, not a
// cascade — and it belongs in whichever module owns page deletion.
//
// Same single-in-flight-promise DDL guard as funnels.js / pageVersionsSchema.js:
// concurrent first requests must not run CREATE TABLE in parallel (Postgres
// throws a pg_type unique violation).
import { client as sharedClient, pgQuery } from '../db/pg.js';

// The bound. Exported so the route, the panel contract and the harness read ONE
// number instead of three that can drift apart.
export const THREAD_LIMIT = 50;

// A stored message body is capped at the same per-message ceiling the chat
// endpoint enforces on input, so a reply can never be stored in a shape the
// request validator would refuse to send back.
export const THREAD_TEXT_MAX = 20_000;

// Roles the transcript can hold. 'error' is deliberately NOT one of them — a
// failed turn is not part of the conversation the model is shown.
const ROLES = new Set(['user', 'assistant']);

let tablesReadyPromise = null;

/**
 * Idempotently create the AI-Developer chat table. Safe to call per request.
 * @param {(text: string, params?: any[]) => Promise<any[]>} [query] — injected
 *   query fn (defaults to the shared pgQuery); harnesses pass a scoped client.
 */
export function ensureAiDevChatTables(query = pgQuery) {
  if (!tablesReadyPromise) {
    tablesReadyPromise = createTables(query).catch((err) => {
      tablesReadyPromise = null;
      throw err;
    });
  }
  return tablesReadyPromise;
}

// Test-only: drop the memoized promise so a harness can re-run DDL against a
// fresh database inside one process. Never called by the server.
export function __resetAiDevChatSchemaCache() {
  tablesReadyPromise = null;
}

async function createTables(query) {
  // funnel_id is carried on the ROW (not only reachable through page_id) so
  // every read and every delete is pinned to the caller's funnel in a single
  // predicate — a thread can never be read or cleared across the funnel
  // boundary even if a page id is guessed. Same posture as lb_page_versions.
  await query(`
    CREATE TABLE IF NOT EXISTS lb_ai_dev_chats (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      ops_count INTEGER NOT NULL DEFAULT 0,
      image_count INTEGER NOT NULL DEFAULT 0,
      attachment JSONB,
      model TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The one index the feature needs: read and prune both walk
  // (page_id, funnel_id, id DESC).
  await query(
    `CREATE INDEX IF NOT EXISTS idx_lb_ai_dev_chats_page
       ON lb_ai_dev_chats (page_id, funnel_id, id DESC)`
  );
  // The epoch row. The PRIMARY KEY is what makes the upsert atomic and what
  // every append locks — see the header.
  await query(`
    CREATE TABLE IF NOT EXISTS lb_ai_dev_threads (
      page_id TEXT NOT NULL,
      funnel_id TEXT NOT NULL,
      epoch BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (page_id, funnel_id)
    )
  `);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * BOTH-SHAPES jsonb read. postgres.js hands a jsonb column back already parsed
 * (object/array), but the SAME column read through a different driver, a view,
 * a ::text cast, or a row written before the column was jsonb comes back as a
 * STRING. Reading only one shape means the attachment chip silently disappears
 * on half the deployments. Anything that is neither → null, never a throw.
 * @param {unknown} raw
 * @returns {object|null}
 */
export function readJsonbObject(raw) {
  if (raw == null) return null;
  if (isPlainObject(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null; // a non-JSON string in a jsonb column is corrupt, not fatal
    }
  }
  return null;
}

/**
 * Normalize a stored row into the wire shape the panel consumes. Defensive
 * about every column: a legacy NULL ops_count must read as 0, a missing
 * attachment as null, an unknown role as 'assistant' rather than as a message
 * the client cannot render.
 * @param {object} row
 */
export function readStoredMessage(row) {
  const r = isPlainObject(row) ? row : {};
  const role = ROLES.has(r.role) ? r.role : 'assistant';
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    id: r.id == null ? null : String(r.id),
    role,
    content: typeof r.content === 'string' ? r.content : '',
    ops_count: num(r.ops_count),
    image_count: num(r.image_count),
    attachment: readJsonbObject(r.attachment),
    model: typeof r.model === 'string' && r.model ? r.model : null,
    created_at: r.created_at instanceof Date
      ? r.created_at.toISOString()
      : (r.created_at == null ? null : String(r.created_at)),
  };
}

/**
 * Keep the NEWEST `limit` entries of an ascending (oldest-first) list, IN
 * ORDER. The read query already applies the bound in SQL; this is the same
 * bound expressed once, purely, so the harness can prove it and so a caller
 * that assembles a thread in memory (the POST turn) cannot hand back more than
 * the contract promises.
 * @param {Array} messages — oldest first
 * @param {number} [limit]
 */
export function boundThread(messages, limit = THREAD_LIMIT) {
  if (!Array.isArray(messages)) return [];
  const n = Number.isInteger(limit) && limit > 0 ? limit : THREAD_LIMIT;
  return messages.length <= n ? messages.slice() : messages.slice(messages.length - n);
}

/**
 * Coerce one message into the storable shape, or null when it is not storable.
 * Truncation is SILENT on purpose: a reply longer than the ceiling is still
 * worth keeping in the transcript, and refusing the whole turn over its length
 * would lose the operator's message too.
 */
export function normalizeForStore(msg) {
  if (!isPlainObject(msg)) return null;
  if (!ROLES.has(msg.role)) return null;
  const content = typeof msg.content === 'string' ? msg.content.slice(0, THREAD_TEXT_MAX) : '';
  const clampCount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10_000) : 0;
  };
  return {
    role: msg.role,
    content,
    ops_count: clampCount(msg.ops_count),
    image_count: clampCount(msg.image_count),
    attachment: isPlainObject(msg.attachment) ? msg.attachment : null,
    model: typeof msg.model === 'string' ? msg.model.slice(0, 64) : null,
  };
}

// ---------------------------------------------------------------------------
// Reads / writes
// ---------------------------------------------------------------------------

/**
 * Read the bounded thread for (pageId, funnelId), OLDEST FIRST.
 *
 * The bound is applied by taking the newest N in SQL (id DESC LIMIT) and then
 * reversing in JS — NOT by `ORDER BY id ASC LIMIT`, which would hand back the
 * OLDEST 50 and quietly hide every recent turn once a thread passes the cap.
 */
export async function readThread(pageId, funnelId, { limit = THREAD_LIMIT, query = pgQuery } = {}) {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, THREAD_LIMIT) : THREAD_LIMIT;
  const rows = await query(
    `SELECT id, role, content, ops_count, image_count, attachment, model, created_at
       FROM lb_ai_dev_chats
      WHERE page_id = $1 AND funnel_id = $2
      ORDER BY id DESC
      LIMIT ${n}`,
    [pageId, funnelId]
  );
  return rows.map(readStoredMessage).reverse();
}

/**
 * Ensure this thread's epoch row exists and return its current epoch.
 *
 * The route calls this at the START of a turn, for two reasons: it is the value
 * the later append is checked against, and it GUARANTEES the row exists so the
 * append's `FOR UPDATE` has something to lock. Without the row, a `FOR UPDATE`
 * matching nothing locks nothing, and a concurrent DELETE could interleave
 * between the append's check and its insert.
 *
 * @returns {Promise<string>} the epoch, as a STRING (it is a BIGINT)
 */
export async function openThreadEpoch(pageId, funnelId, { query = pgQuery } = {}) {
  const rows = await query(
    `INSERT INTO lb_ai_dev_threads (page_id, funnel_id, epoch)
     VALUES ($1, $2, 0)
     ON CONFLICT (page_id, funnel_id) DO UPDATE SET page_id = EXCLUDED.page_id
     RETURNING epoch`,
    [pageId, funnelId]
  );
  // The DO UPDATE is a deliberate no-op write: ON CONFLICT DO NOTHING returns
  // NO ROW, which would leave the caller unable to read the existing epoch.
  return String(rows[0].epoch);
}

/**
 * Read this thread's epoch without creating the row. Returns '0' when absent.
 */
export async function readThreadEpoch(pageId, funnelId, { query = pgQuery } = {}) {
  const rows = await query(
    `SELECT epoch FROM lb_ai_dev_threads WHERE page_id = $1 AND funnel_id = $2`,
    [pageId, funnelId]
  );
  return rows.length ? String(rows[0].epoch) : '0';
}

/**
 * Append messages and prune the thread back to THREAD_LIMIT — both inside ONE
 * transaction, so a reader never sees a thread that grew past the cap and a
 * failed prune can never leave the insert behind.
 *
 * `expectEpoch` is the epoch the caller read when its turn STARTED. If the
 * thread has been cleared since, the epoch has moved and this writes NOTHING —
 * an operator who clears a conversation must not have it repopulated by a turn
 * that was already in flight. Omit it (undefined) to append unconditionally.
 *
 * @returns {Promise<number>} how many rows were actually written (0 if the
 *   epoch moved — the caller can distinguish "nothing to write" from "the
 *   thread was cleared underneath me" by comparing against its input length)
 */
export async function appendThread(
  pageId, funnelId, messages, { createdBy = null, client, expectEpoch } = {}
) {
  const rows = (Array.isArray(messages) ? messages : [])
    .map(normalizeForStore)
    .filter(Boolean);
  if (!rows.length) return 0;

  const sql = client || sharedClient;
  let wrote = 0;

  await sql.begin(async (tx) => {
    // THE SERIALIZATION POINT. Locking the epoch row does double duty: it makes
    // concurrent appends to one thread run one at a time (so the prune below
    // sees the true count and the bound is EXACT), and it is what a concurrent
    // DELETE must wait on before it can bump the epoch.
    //
    // The row is CREATED HERE if absent rather than assumed. `FOR UPDATE` that
    // matches no row locks NOTHING — so on a thread whose first turn had not yet
    // opened an epoch, appends did not serialize at all and the prune went back
    // to being eventual (measured: 40 parallel appends left 58 rows, not 50).
    // The guarantee must not depend on a caller having called openThreadEpoch.
    await tx.unsafe(
      `INSERT INTO lb_ai_dev_threads (page_id, funnel_id, epoch)
       VALUES ($1, $2, 0)
       ON CONFLICT (page_id, funnel_id) DO UPDATE SET page_id = EXCLUDED.page_id`,
      [pageId, funnelId]
    );
    const locked = await tx.unsafe(
      `SELECT epoch FROM lb_ai_dev_threads
        WHERE page_id = $1 AND funnel_id = $2
        FOR UPDATE`,
      [pageId, funnelId]
    );
    if (expectEpoch !== undefined) {
      const current = locked.length ? String(locked[0].epoch) : '0';
      // Compared as STRINGS. These are BIGINTs: a Number round-trip is lossy
      // past 2^53, and an epoch is monotonic, so equality is all that is needed.
      if (current !== String(expectEpoch)) return; // cleared mid-turn — stand down
    }
    wrote = rows.length;
    for (const m of rows) {
      await tx.unsafe(
        `INSERT INTO lb_ai_dev_chats
           (page_id, funnel_id, role, content, ops_count, image_count, attachment, model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9)`,
        [
          pageId, funnelId, m.role, m.content, m.ops_count, m.image_count,
          // jsonb discipline, and the cast is `::text::jsonb` for a REASON.
          //
          // postgres.js infers the parameter's type from the cast it sees. With
          // a bare `$7::jsonb` it sends the JS string ALREADY JSON-ENCODED, so
          // Postgres parses `"{\"block_id\":…}"` and stores a jsonb STRING —
          // jsonb_typeof() answers 'string', `attachment->>'block_id'` answers
          // NULL, and the chip silently loses its target on every read. Verified
          // by execution: `$1::jsonb` → 'string', `$2::text::jsonb` → 'object'.
          //
          // Routing through ::text pins the parameter as text and lets Postgres
          // — not the driver — do the one and only JSON parse.
          m.attachment ? JSON.stringify(m.attachment) : null,
          m.model, createdBy,
        ]
      );
    }
    // Prune to the newest THREAD_LIMIT for this (page, funnel). The subquery is
    // the SAME (id DESC) order readThread uses, so "what survives" is exactly
    // "what the next read would have shown".
    //
    // EXACT, not eventual — the epoch-row lock above serializes appends to this
    // thread, so this DELETE sees the true row count rather than a count another
    // in-flight insert is about to change.
    await tx.unsafe(
      `DELETE FROM lb_ai_dev_chats
        WHERE page_id = $1 AND funnel_id = $2
          AND id NOT IN (
            SELECT id FROM lb_ai_dev_chats
             WHERE page_id = $1 AND funnel_id = $2
             ORDER BY id DESC
             LIMIT ${THREAD_LIMIT}
          )`,
      [pageId, funnelId]
    );
  });

  return wrote;
}

/**
 * Delete the whole thread for (pageId, funnelId) and BUMP its epoch.
 *
 * The bump is what makes a clear win over a turn that is already streaming: an
 * append still holding the old epoch will find it stale and write nothing. Both
 * statements run in ONE transaction, and the epoch row is locked FIRST — so a
 * concurrent append either finishes before the clear (and has its rows deleted
 * by it) or starts after (and is refused). There is no interleaving in which
 * the operator's clear is quietly undone.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function clearThread(pageId, funnelId, { client } = {}) {
  const sql = client || sharedClient;
  let deletedCount = 0;

  await sql.begin(async (tx) => {
    // Take the lock FIRST, creating the row if this thread never had a turn, so
    // an append that is mid-flight must wait here rather than slip between the
    // delete and the bump.
    await tx.unsafe(
      `INSERT INTO lb_ai_dev_threads (page_id, funnel_id, epoch)
       VALUES ($1, $2, 0)
       ON CONFLICT (page_id, funnel_id) DO UPDATE SET page_id = EXCLUDED.page_id`,
      [pageId, funnelId]
    );
    await tx.unsafe(
      `SELECT epoch FROM lb_ai_dev_threads
        WHERE page_id = $1 AND funnel_id = $2 FOR UPDATE`,
      [pageId, funnelId]
    );
    const deleted = await tx.unsafe(
      `DELETE FROM lb_ai_dev_chats WHERE page_id = $1 AND funnel_id = $2 RETURNING id`,
      [pageId, funnelId]
    );
    deletedCount = deleted.length;
    await tx.unsafe(
      `UPDATE lb_ai_dev_threads SET epoch = epoch + 1, updated_at = NOW()
        WHERE page_id = $1 AND funnel_id = $2`,
      [pageId, funnelId]
    );
  });

  return deletedCount;
}

