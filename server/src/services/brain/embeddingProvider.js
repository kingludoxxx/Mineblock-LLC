// EMBEDDING PROVIDER — an INTERFACE with a no-vector fallback.
//
// Two independent facts decide how the Brain searches, and BOTH are read at
// request time (R7), never baked in at import:
//
//   1. is there an embedding provider?  → OPENAI_API_KEY set  → text-embedding-3-small
//   2. can this database store vectors? → kb_embeddings.embedding column exists,
//      which migration 129 creates only where pgvector is available
//
// Both true  → semantic search over pgvector.
// Either false → the tsvector keyword path (migration 128 keeps `search_tsv`
// GENERATED on both tables, so the fallback is never a second-class citizen).
//
// Render Postgres 16 ships pgvector; the local Postgres 16 the lanes test on does
// not (`CREATE EXTENSION vector` → 'extension "vector" is not available'), which
// is exactly why this seam exists rather than a hard dependency.

export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBEDDING_DIM = 1536;
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/**
 * The provider for THIS request, or null when none is configured.
 * @param {{fetchImpl?: Function}} [opts]
 * @returns {{name:string, model:string, dim:number, embed:(texts:string[])=>Promise<number[][]>}|null}
 */
export function getEmbeddingProvider({ fetchImpl = globalThis.fetch } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || String(key).trim() === '') return null;
  return {
    name: 'openai',
    model: OPENAI_EMBEDDING_MODEL,
    dim: OPENAI_EMBEDDING_DIM,
    async embed(texts) {
      const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
      if (!input.length) return [];
      const res = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        // The key travels in a HEADER, never in the URL or argv.
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Say the upstream failed. An empty vector set is indistinguishable from
        // "nothing matched", which is the bug this refusal exists to prevent.
        throw new Error(`embedding provider ${res.status}: ${body.slice(0, 300)}`);
      }
      const j = await res.json();
      const out = (j?.data || []).map((d) => d.embedding);
      if (out.length !== input.length) throw new Error(`embedding provider returned ${out.length} vectors for ${input.length} inputs`);
      return out;
    },
  };
}

/**
 * Does THIS database have the pgvector column? Asked of the database, not of an
 * env flag, so a store that gains pgvector needs only migration 129 re-run.
 * @param {import('postgres').Sql} sql
 */
export async function vectorColumnAvailable(sql) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kb_embeddings' AND column_name = 'embedding'
    LIMIT 1`;
  return rows.length > 0;
}

/** pgvector literal: '[0.1,0.2,…]'. */
export function toVectorLiteral(vec) {
  return `[${vec.map((n) => Number(n)).join(',')}]`;
}

export default { getEmbeddingProvider, vectorColumnAvailable, toVectorLiteral, OPENAI_EMBEDDING_MODEL, OPENAI_EMBEDDING_DIM };
