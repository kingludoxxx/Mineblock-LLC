// THE STORE BRAIN — retrieval.
//
// Scoped BY CONSTRUCTION: this function runs inside one store's dashboard against
// that store's database. There is no store parameter, so there is nothing to get
// wrong — a leak would need a second database on the same connection, which the
// deployment model does not create.
//
// Two paths, chosen at REQUEST time from what actually exists (R7):
//   vector   — an embedding provider IS configured AND this database has the
//              pgvector column migration 129 creates where the extension exists
//   keyword  — otherwise: Postgres full-text over the GENERATED search_tsv
//              columns migration 128 keeps on kb_documents and kb_insights
// Both paths return the SAME shape and both carry CITATIONS: a result is never
// usable without the document ids and quotes it came from.
//
// approved_only defaults TRUE. Unapproved insights are visible on request (a
// reviewer has to see them) but a pipeline calling with the default never sees
// one (R16).

import {
  BrainError, assertProductCode, assertInsightType, clampLimit,
} from './brain/brainSchema.js';
import { getEmbeddingProvider, vectorColumnAvailable, toVectorLiteral } from './brain/embeddingProvider.js';
import { citationsFor, backfillInsightEmbeddings } from './brainStore.js';

const KINDS = ['document', 'insight'];

function endOfDay(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s;
}
function startOf(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
}

function parseFilters(opts, { mayReadUnapproved = false } = {}) {
  const q = String(opts.q ?? '').trim();
  if (!q) throw new BrainError('no_query', 'q is required');
  const kind = opts.type ? String(opts.type).trim() : null;
  if (kind && !KINDS.includes(kind)) throw new BrainError('bad_type', `type must be one of: ${KINDS.join(', ')}`);

  // P0-3: the flag came off the query string with no reference to WHO was asking,
  // so the one thing R16 forbids — a pipeline reading unapproved insights — was
  // one query parameter away for the exact caller R16 is about. Seeing
  // unapproved work is a REVIEWER's privilege; the caller must be able to approve.
  const wantsUnapproved = opts.approved_only === false || String(opts.approved_only).toLowerCase() === 'false';
  if (wantsUnapproved && !mayReadUnapproved) {
    throw new BrainError('approval_scope',
      'approved_only=false shows unapproved insights and is limited to reviewers (brain:approve) — a service credential always reads the approved layer', 403);
  }
  const approvedOnly = !wantsUnapproved;
  return {
    q,
    kind,
    approvedOnly,
    product: assertProductCode(opts.product ?? null),
    source: opts.source ? String(opts.source).trim() : null,
    insightType: opts.insight_type ? assertInsightType(opts.insight_type) : null,
    from: startOf(opts.from),
    to: endOfDay(opts.to),
    limit: clampLimit(opts.limit),
  };
}

// Shared predicates. Each query gets its OWN parameter list: an unused $n in a
// prepared statement is a "could not determine data type of parameter" error, so
// the two halves cannot share one array.
//   documents: $1 q/vector, $2 product, $3 source, $4 from, $5 to, $6 limit, $7 model
//   insights:  $1 q/vector, $2 product, $3 source, $4 from, $5 to, $6 type,
//              $7 approved_only, $8 limit, $9 model
const DOC_WHERE = `
      AND ($2::text IS NULL OR d.product_code = $2)
      AND ($3::text IS NULL OR d.source = $3)
      AND ($4::timestamptz IS NULL OR d.captured_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR d.captured_at <= $5::timestamptz)`;

const INSIGHT_WHERE = `
      AND ($2::text IS NULL OR i.product_code = $2)
      AND ($4::timestamptz IS NULL OR i.created_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR i.created_at <= $5::timestamptz)
      AND ($6::text IS NULL OR i.insight_type = $6)
      AND ($7::boolean IS FALSE OR i.status = 'approved')
      AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM kb_insight_sources s
            JOIN kb_documents d2 ON d2.id = s.document_id
            WHERE s.insight_id = i.id AND d2.source = $3))`;

async function keywordSearch(sql, f) {
  const docParams = [f.q, f.product, f.source, f.from, f.to, f.limit];
  const insParams = [f.q, f.product, f.source, f.from, f.to, f.insightType, f.approvedOnly, f.limit];
  const out = [];
  if (f.kind !== 'insight') {
    const rows = await sql.unsafe(`
      SELECT d.id, ts_rank_cd(d.search_tsv, qq) AS score, d.title, d.source, d.url,
             d.product_code, d.captured_at,
             ts_headline('english', d.body_text, qq,
                         'MaxFragments=1,MinWords=5,MaxWords=28,StartSel=<<,StopSel=>>') AS quote
      FROM kb_documents d, plainto_tsquery('english', $1) qq
      WHERE d.search_tsv @@ qq ${DOC_WHERE}
      ORDER BY score DESC, d.id DESC
      LIMIT $6`, docParams);
    for (const r of rows) {
      out.push({
        kind: 'document', id: Number(r.id), score: Number(r.score), title: r.title,
        source: r.source, url: r.url, product_code: r.product_code, captured_at: r.captured_at,
        quote: r.quote,
        citations: [{ document_id: Number(r.id), quote: r.quote, source: r.source, url: r.url, title: r.title }],
      });
    }
  }
  if (f.kind !== 'document') {
    const rows = await sql.unsafe(`
      SELECT i.id, ts_rank_cd(i.search_tsv, qq) AS score, i.insight_type, i.body, i.quote,
             i.status, i.confidence, i.product_code, i.created_at
      FROM kb_insights i, plainto_tsquery('english', $1) qq
      WHERE i.search_tsv @@ qq ${INSIGHT_WHERE}
      ORDER BY score DESC, i.id DESC
      LIMIT $8`, insParams);
    const cites = await citationsFor(sql, rows.map((r) => Number(r.id)));
    for (const r of rows) {
      out.push({
        kind: 'insight', id: Number(r.id), score: Number(r.score), insight_type: r.insight_type,
        body: r.body, quote: r.quote, status: r.status, confidence: Number(r.confidence),
        product_code: r.product_code, created_at: r.created_at,
        citations: cites.get(Number(r.id)) || [],
      });
    }
  }
  return out;
}

async function vectorSearch(sql, f, provider) {
  const [vec] = await provider.embed([f.q]);
  const lit = toVectorLiteral(vec);
  const docParams = [lit, f.product, f.source, f.from, f.to, f.limit, provider.model];
  const insParams = [lit, f.product, f.source, f.from, f.to, f.insightType, f.approvedOnly, f.limit, provider.model];
  const out = [];
  if (f.kind !== 'insight') {
    const rows = await sql.unsafe(`
      SELECT d.id, 1 - (e.embedding <=> $1::vector) AS score, d.title, d.source, d.url,
             d.product_code, d.captured_at, left(e.chunk_text, 280) AS quote
      FROM kb_embeddings e JOIN kb_documents d ON d.id = e.document_id
      WHERE e.embedding IS NOT NULL AND e.model = $7 ${DOC_WHERE}
      ORDER BY e.embedding <=> $1::vector
      LIMIT $6`, docParams);
    for (const r of rows) {
      out.push({
        kind: 'document', id: Number(r.id), score: Number(r.score), title: r.title,
        source: r.source, url: r.url, product_code: r.product_code, captured_at: r.captured_at,
        quote: r.quote,
        citations: [{ document_id: Number(r.id), quote: r.quote, source: r.source, url: r.url, title: r.title }],
      });
    }
  }
  if (f.kind !== 'document') {
    // The insight half only answers where insight vectors EXIST. Rows approved
    // before this path could write them (or while no provider was configured)
    // would otherwise stay invisible for ever, silently — so catch them up here,
    // bounded, before the join runs. A reviewer reading unapproved work needs the
    // proposed rows embedded too, or `approved_only=false` is empty in vector mode.
    const statuses = f.approvedOnly ? ['approved'] : ['approved', 'proposed'];
    await backfillInsightEmbeddings(sql, { provider, statuses });
    const rows = await sql.unsafe(`
      SELECT i.id, 1 - (e.embedding <=> $1::vector) AS score, i.insight_type, i.body, i.quote,
             i.status, i.confidence, i.product_code, i.created_at
      FROM kb_embeddings e JOIN kb_insights i ON i.id = e.insight_id
      WHERE e.embedding IS NOT NULL AND e.model = $9 ${INSIGHT_WHERE}
      ORDER BY e.embedding <=> $1::vector
      LIMIT $8`, insParams);
    const cites = await citationsFor(sql, rows.map((r) => Number(r.id)));
    for (const r of rows) {
      out.push({
        kind: 'insight', id: Number(r.id), score: Number(r.score), insight_type: r.insight_type,
        body: r.body, quote: r.quote, status: r.status, confidence: Number(r.confidence),
        product_code: r.product_code, created_at: r.created_at,
        citations: cites.get(Number(r.id)) || [],
      });
    }
  }
  return out;
}

/**
 * @param {import('postgres').Sql} sql  this store's database — the only one reachable
 * @param {object} opts  q, type, product, source, insight_type, from, to, approved_only, limit
 * @param {{mayReadUnapproved?: boolean}} [ctx]  the CALLER's standing, decided by the
 *   route from the credential presented — never by the query string (P0-3)
 * @returns {{mode:'vector'|'keyword', limit:number, approved_only:boolean, results:object[]}}
 */
export async function search(sql, opts = {}, ctx = {}) {
  const f = parseFilters(opts, ctx);
  const provider = opts.provider !== undefined ? opts.provider : getEmbeddingProvider();
  const canVector = provider ? await vectorColumnAvailable(sql) : false;
  const mode = provider && canVector ? 'vector' : 'keyword';
  const results = mode === 'vector' ? await vectorSearch(sql, f, provider) : await keywordSearch(sql, f);
  results.sort((a, b) => b.score - a.score);
  return {
    mode, limit: f.limit, approved_only: f.approvedOnly,
    results: results.slice(0, f.limit),
  };
}

export default { search };
