// AI DEVELOPER — persisted chat thread (SCHEMA OWNER, self-contained new file).
//
// One table, lb_ai_dev_chats: an append-only, per-(page, funnel) transcript of
// the AI Developer conversation, ONE ROW PER MESSAGE.
//
// WHY ONE ROW PER MESSAGE rather than one row holding a jsonb array. The bound
// ("keep the last 50") is then a DELETE with an ORDER BY, executed in the same
// transaction as the INSERT — a burst of turns can never outrun a pruner and
// grow the row unbounded, and there is no read-modify-write window in which two
// concurrent turns can each append to a stale copy of the array and lose one.
// (The reference tool stores a single Mongo doc with an embedded array and
// accepts that race; Postgres gives us the cheaper, correct shape for free.)
//
// ⛔ WHAT IS NEVER STORED: image BYTES. Pasted screenshots are pass-through
// only — they ride into the Anthropic request and are never written to this
// table, to disk, or anywhere else. A stored user message carries an
// `image_count` so the panel can render "2 screenshots" on a rehydrated turn,
// and nothing more. This is a DELIBERATE DIVERGENCE from the reference, which
// uploads operator screenshots to object storage and persists their URLs.
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
 * Append messages and prune the thread back to THREAD_LIMIT — both inside ONE
 * transaction, so a reader never sees a thread that grew past the cap and a
 * failed prune can never leave the insert behind.
 *
 * @returns {Promise<number>} how many rows were actually written
 */
export async function appendThread(pageId, funnelId, messages, { createdBy = null, client } = {}) {
  const rows = (Array.isArray(messages) ? messages : [])
    .map(normalizeForStore)
    .filter(Boolean);
  if (!rows.length) return 0;

  const sql = client || sharedClient;

  await sql.begin(async (tx) => {
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

  return rows.length;
}

/**
 * Delete the whole thread for (pageId, funnelId).
 * @returns {Promise<number>} rows deleted
 */
export async function clearThread(pageId, funnelId, { query = pgQuery } = {}) {
  const deleted = await query(
    `DELETE FROM lb_ai_dev_chats WHERE page_id = $1 AND funnel_id = $2 RETURNING id`,
    [pageId, funnelId]
  );
  return deleted.length;
}
