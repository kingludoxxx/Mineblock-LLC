// THE STORE BRAIN — writes and reads for layers 1 (raw sources), 2 (insights)
// and 3 (playbook). Every function takes the `sql` handle explicitly: the Brain
// is whatever database this process is connected to, and there is no store
// parameter anywhere in this file. That is the isolation property (physical, not
// filtered) and it is why nothing here can be asked about another store.
//
// R15: no product / store / brand literal. Codes are DATA, validated against
// PRODUCT_CODES_JSON by brainSchema at request time.

import {
  BrainError, assertProductCode, assertInsightType, assertStatus, assertSection,
  contentHash, rawObjectKey, clampLimit, BODY_MAX_BYTES,
} from './brain/brainSchema.js';
import { getEmbeddingProvider, vectorColumnAvailable, toVectorLiteral } from './brain/embeddingProvider.js';

/**
 * Postgres returns int8 as a STRING through postgres.js. Half this API produced
 * strings (a row straight from the table) and half produced numbers (a computed
 * search result), so `document.id === result.id` was false for the SAME row — a
 * caller comparing them silently got nothing. Every id this module hands out is
 * a NUMBER, in one place, so the API has one id type.
 */
const num = (v) => (v === null || v === undefined ? null : Number(v));

const ID_FIELDS = ['id', 'document_id', 'insight_id', 'entry_id', 'extraction_job_id'];
function withNumericIds(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of ID_FIELDS) if (f in out) out[f] = num(out[f]);
  return out;
}

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// ── Layer 1: RAW SOURCES ────────────────────────────────────────────────────

/**
 * Ingest one document AS CAPTURED. Idempotent by (content hash, product code):
 * re-ingesting the same bytes for the same product returns the existing row and
 * writes nothing. Documents are immutable — an edited source is a NEW document.
 *
 * The body itself belongs in the bucket under knowledge/raw/<source>/<date>/;
 * this function computes and records that key. Uploading is the caller's job
 * (the ingest route does it when R2 is configured), so a Brain still works with
 * no bucket at all: body_text is always kept in the database for search.
 */
export async function ingestDocument(sql, input = {}, { actor = null } = {}) {
  const source = trimOrNull(input.source);
  if (!source) throw new BrainError('bad_source', 'source is required (reddit, trustpilot, operator research, …)');
  const text = String(input.text ?? input.body_text ?? '');
  if (text.trim() === '') throw new BrainError('empty_document', 'a document with no text cannot be ingested');
  if (Buffer.byteLength(text, 'utf8') > BODY_MAX_BYTES) {
    throw new BrainError('document_too_large', `document exceeds ${BODY_MAX_BYTES} bytes`);
  }
  const productCode = assertProductCode(input.product_code ?? input.productCode ?? null);
  const capturedAt = input.captured_at ? new Date(input.captured_at) : new Date();
  if (Number.isNaN(capturedAt.getTime())) throw new BrainError('bad_captured_at', 'captured_at is not a date');

  const hash = contentHash(text);
  const contentType = trimOrNull(input.content_type) || 'text/plain';
  const key = trimOrNull(input.body_object_key)
    || rawObjectKey({ source, capturedAt, hash, contentType, ext: input.ext || null });

  const existing = await sql`
    SELECT * FROM kb_documents
    WHERE content_hash = ${hash} AND COALESCE(product_code, '') = ${productCode || ''}
    LIMIT 1`;
  if (existing.length) return { document: withNumericIds(existing[0]), created: false };

  const rows = await sql`
    INSERT INTO kb_documents
      (content_hash, source, source_ref, url, title, body_text, body_object_key,
       content_type, byte_size, lang, product_code, captured_at, scrape_job_id, ingested_by, metadata)
    VALUES
      (${hash}, ${source}, ${trimOrNull(input.source_ref)}, ${trimOrNull(input.url)},
       ${trimOrNull(input.title)}, ${text}, ${key}, ${contentType},
       ${Buffer.byteLength(text, 'utf8')}, ${trimOrNull(input.lang)}, ${productCode},
       ${capturedAt}, ${trimOrNull(input.scrape_job_id)}, ${trimOrNull(actor)},
       ${sql.json(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})})
    ON CONFLICT (content_hash, COALESCE(product_code, '')) DO NOTHING
    RETURNING *`;
  if (rows.length) return { document: withNumericIds(rows[0]), created: true };

  // Lost a race with a concurrent identical ingest — that is idempotency working.
  const again = await sql`
    SELECT * FROM kb_documents
    WHERE content_hash = ${hash} AND COALESCE(product_code, '') = ${productCode || ''}
    LIMIT 1`;
  if (!again.length) throw new BrainError('ingest_failed', 'the document could not be written', 500);
  return { document: withNumericIds(again[0]), created: false };
}

export async function getDocument(sql, id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) throw new BrainError('bad_id', 'document id must be an integer');
  const rows = await sql`SELECT * FROM kb_documents WHERE id = ${n} LIMIT 1`;
  if (!rows.length) throw new BrainError('not_found', `no document ${n} in this store's Brain`, 404);
  return withNumericIds(rows[0]);
}

export async function listDocuments(sql, filters = {}) {
  const limit = clampLimit(filters.limit);
  const product = assertProductCode(filters.product ?? null);
  const source = trimOrNull(filters.source);
  const rows = await sql`
    SELECT id, source, url, title, product_code, captured_at, byte_size, body_object_key
    FROM kb_documents
    WHERE (${product}::text IS NULL OR product_code = ${product})
      AND (${source}::text IS NULL OR source = ${source})
    ORDER BY captured_at DESC, id DESC
    LIMIT ${limit}`;
  return { documents: rows.map(withNumericIds), limit };
}

// ── Layer 2: INSIGHTS ───────────────────────────────────────────────────────

/** The provenance rows for a set of insight ids: {insightId → [{document_id, quote}]}. */
export async function citationsFor(sql, insightIds) {
  if (!insightIds.length) return new Map();
  const rows = await sql`
    SELECT s.insight_id, s.document_id, s.quote, d.source, d.url, d.title
    FROM kb_insight_sources s
    JOIN kb_documents d ON d.id = s.document_id
    WHERE s.insight_id = ANY(${sql.array(insightIds.map(Number))}::bigint[])`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(Number(r.insight_id))) out.set(Number(r.insight_id), []);
    out.get(Number(r.insight_id)).push({
      document_id: Number(r.document_id), quote: r.quote, source: r.source, url: r.url, title: r.title,
    });
  }
  return out;
}

/**
 * Propose an insight. ALWAYS lands `proposed` — a create path that could write
 * `approved` is the one bug this layer exists to prevent (R16). At least one
 * source document is required: an insight with no provenance is an assertion.
 */
export async function createInsight(sql, input = {}, { actor = null, extractionJobId = null } = {}) {
  const insightType = assertInsightType(input.insight_type ?? input.insightType);
  const body = trimOrNull(input.body);
  if (!body) throw new BrainError('empty_insight', 'body is required');
  const productCode = assertProductCode(input.product_code ?? input.productCode ?? null);
  const sourceIds = (input.source_document_ids ?? input.sourceDocumentIds ?? [])
    .map((v) => Number.parseInt(v, 10)).filter((n) => Number.isFinite(n));
  if (!sourceIds.length) {
    throw new BrainError('no_provenance', 'source_document_ids must name at least one document — an insight without provenance is an assertion, not an insight');
  }
  const found = await sql`SELECT id FROM kb_documents WHERE id = ANY(${sql.array(sourceIds)}::bigint[])`;
  const foundIds = new Set(found.map((r) => Number(r.id)));
  const missing = sourceIds.filter((id) => !foundIds.has(id));
  if (missing.length) throw new BrainError('bad_provenance', `source document(s) not in this store's Brain: ${missing.join(', ')}`);

  let confidence = Number(input.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  if (confidence < 0 || confidence > 1) throw new BrainError('bad_confidence', 'confidence must be between 0 and 1');

  const rows = await sql`
    INSERT INTO kb_insights
      (insight_type, product_code, body, quote, confidence, status, proposed_by,
       extraction_job_id, global_ref_kind, global_ref_id, metadata)
    VALUES
      (${insightType}, ${productCode}, ${body}, ${trimOrNull(input.quote)}, ${confidence},
       'proposed', ${trimOrNull(actor)}, ${extractionJobId},
       ${trimOrNull(input.global_ref_kind)}, ${trimOrNull(input.global_ref_id)},
       ${sql.json(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})})
    RETURNING *`;
  const insight = withNumericIds(rows[0]);
  for (const documentId of sourceIds) {
    await sql`
      INSERT INTO kb_insight_sources (insight_id, document_id, quote)
      VALUES (${insight.id}, ${documentId}, ${trimOrNull(input.quote)})
      ON CONFLICT (insight_id, document_id) DO NOTHING`;
  }
  return insight;
}

export async function listInsights(sql, filters = {}) {
  const limit = clampLimit(filters.limit);
  const product = assertProductCode(filters.product ?? null);
  const status = filters.status ? assertStatus(filters.status) : null;
  const type = filters.insight_type ? assertInsightType(filters.insight_type) : null;
  const rows = await sql`
    SELECT * FROM kb_insights
    WHERE (${product}::text IS NULL OR product_code = ${product})
      AND (${status}::text IS NULL OR status = ${status})
      AND (${type}::text IS NULL OR insight_type = ${type})
    ORDER BY id DESC
    LIMIT ${limit}`;
  const cites = await citationsFor(sql, rows.map((r) => Number(r.id)));
  return { insights: rows.map((r) => ({ ...withNumericIds(r), citations: cites.get(Number(r.id)) || [] })), limit };
}

/** Approve or reject. The actor is recorded; there is no anonymous approval. */
export async function setInsightStatus(sql, id, status, { actor = null, reason = null } = {}) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) throw new BrainError('bad_id', 'insight id must be an integer');
  const s = assertStatus(status);
  if (s === 'proposed') throw new BrainError('bad_status', 'an insight cannot be moved back to proposed; create a new one');
  if (!trimOrNull(actor)) throw new BrainError('no_actor', 'an approval must record who made it', 401);
  const rows = await sql`
    UPDATE kb_insights
    SET status = ${s},
        approved_by = ${s === 'approved' ? String(actor) : null},
        approved_at = ${s === 'approved' ? new Date() : null},
        rejected_reason = ${s === 'rejected' ? trimOrNull(reason) : null},
        updated_at = NOW()
    WHERE id = ${n}
    RETURNING *`;
  if (!rows.length) throw new BrainError('not_found', `no insight ${n} in this store's Brain`, 404);
  return withNumericIds(rows[0]);
}

// ── Layer 3: PLAYBOOK ───────────────────────────────────────────────────────

export async function getPlaybook(sql, productCodeIn) {
  const productCode = assertProductCode(productCodeIn, { required: true });
  const head = await sql`SELECT * FROM playbook_products WHERE product_code = ${productCode} LIMIT 1`;
  const entries = await sql`
    SELECT e.*, COALESCE(
      (SELECT json_agg(c.insight_id ORDER BY c.insight_id) FROM playbook_citations c WHERE c.entry_id = e.id),
      '[]'::json) AS cites
    FROM playbook_entries e WHERE e.product_code = ${productCode}
    ORDER BY e.section, e.position, e.id`;
  const sections = {};
  for (const e of entries) {
    (sections[e.section] ||= []).push({
      key: e.entry_key, position: e.position, value: e.value,
      cites: (e.cites || []).map(Number), updated_by: e.updated_by, updated_at: e.updated_at,
    });
  }
  return {
    product_code: productCode,
    version: head[0]?.version ?? 0,
    locked_at: head[0]?.locked_at ?? null,
    locked_by: head[0]?.locked_by ?? null,
    checkout_url: head[0]?.checkout_url ?? null,
    notes: head[0]?.notes ?? null,
    sections,
  };
}

/**
 * Replace the playbook for one product. Written ONLY through here (the wizard /
 * API); pipelines read it. Each entry may cite insights — the citation is
 * refused when the insight is not in this Brain.
 */
export async function putPlaybook(sql, productCodeIn, payload = {}, { actor = null } = {}) {
  const productCode = assertProductCode(productCodeIn, { required: true });
  const sections = payload.sections && typeof payload.sections === 'object' && !Array.isArray(payload.sections)
    ? payload.sections : {};
  const normalised = [];
  for (const [rawSection, list] of Object.entries(sections)) {
    const section = assertSection(rawSection);
    if (!Array.isArray(list)) throw new BrainError('bad_section_body', `section ${section} must be an array of entries`);
    list.forEach((entry, i) => {
      const key = trimOrNull(entry?.key);
      if (!key) throw new BrainError('bad_entry', `every entry in ${section} needs a key`);
      if (entry.value === undefined || entry.value === null || typeof entry.value !== 'object') {
        throw new BrainError('bad_entry', `entry ${key} in ${section} needs an object value`);
      }
      const cites = (entry.cites || []).map((v) => Number.parseInt(v, 10)).filter((n) => Number.isFinite(n));
      normalised.push({ section, key, position: Number.isFinite(entry.position) ? entry.position : i, value: entry.value, cites });
    });
  }
  const allCites = [...new Set(normalised.flatMap((e) => e.cites))];
  if (allCites.length) {
    const found = await sql`SELECT id FROM kb_insights WHERE id = ANY(${sql.array(allCites)}::bigint[])`;
    const have = new Set(found.map((r) => Number(r.id)));
    const missing = allCites.filter((id) => !have.has(id));
    if (missing.length) throw new BrainError('bad_citation', `cited insight(s) not in this store's Brain: ${missing.join(', ')}`);
  }

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO playbook_products (product_code, version, checkout_url, notes, updated_at)
      VALUES (${productCode}, 1, ${trimOrNull(payload.checkout_url)}, ${trimOrNull(payload.notes)}, NOW())
      ON CONFLICT (product_code) DO UPDATE
        SET version = playbook_products.version + 1,
            checkout_url = EXCLUDED.checkout_url,
            notes = EXCLUDED.notes,
            updated_at = NOW()`;
    await tx`DELETE FROM playbook_entries WHERE product_code = ${productCode}`;
    for (const e of normalised) {
      const [row] = await tx`
        INSERT INTO playbook_entries (product_code, section, entry_key, position, value, updated_by, updated_at)
        VALUES (${productCode}, ${e.section}, ${e.key}, ${e.position}, ${tx.json(e.value)}, ${trimOrNull(actor)}, NOW())
        RETURNING id`;
      for (const insightId of e.cites) {
        await tx`INSERT INTO playbook_citations (entry_id, insight_id) VALUES (${row.id}, ${insightId})
                 ON CONFLICT DO NOTHING`;
      }
    }
  });
  return getPlaybook(sql, productCode);
}

/** Lock the current version: what a pipeline run quotes in its manifest (R16). */
export async function lockPlaybook(sql, productCodeIn, { actor = null } = {}) {
  const productCode = assertProductCode(productCodeIn, { required: true });
  const rows = await sql`
    UPDATE playbook_products SET locked_at = NOW(), locked_by = ${trimOrNull(actor)}, updated_at = NOW()
    WHERE product_code = ${productCode} RETURNING *`;
  if (!rows.length) throw new BrainError('not_found', `no playbook for ${productCode}`, 404);
  return rows[0];
}

// ── Embeddings (written where a provider exists; never required) ────────────

/**
 * Embed a document's text and store the vector. A no-op (with a reason) when
 * there is no provider — the keyword path still indexes the row, so ingest never
 * fails because an optional provider is unconfigured.
 */
export async function embedDocument(sql, documentId, { provider = getEmbeddingProvider() } = {}) {
  if (!provider) return { embedded: false, reason: 'no embedding provider configured' };
  const [doc] = await sql`SELECT id, title, body_text FROM kb_documents WHERE id = ${Number(documentId)}`;
  if (!doc) throw new BrainError('not_found', `no document ${documentId}`, 404);
  const chunk = [doc.title, doc.body_text].filter(Boolean).join('\n').slice(0, 8000);
  const [vec] = await provider.embed([chunk]);
  const hasVector = await vectorColumnAvailable(sql);
  await sql`
    INSERT INTO kb_embeddings (document_id, chunk_index, chunk_text, provider, model, dim, embedding_json)
    VALUES (${doc.id}, 0, ${chunk}, ${provider.name}, ${provider.model}, ${provider.dim}, ${sql.json(vec)})
    ON CONFLICT (document_id, chunk_index, model) WHERE document_id IS NOT NULL
    DO UPDATE SET chunk_text = EXCLUDED.chunk_text, embedding_json = EXCLUDED.embedding_json`;
  if (hasVector) {
    await sql.unsafe(
      'UPDATE kb_embeddings SET embedding = $1::vector WHERE document_id = $2 AND chunk_index = 0 AND model = $3',
      [toVectorLiteral(vec), doc.id, provider.model],
    );
  }
  return { embedded: true, vector_column: hasVector, dim: provider.dim };
}

export default {
  ingestDocument, getDocument, listDocuments,
  createInsight, listInsights, setInsightStatus, citationsFor,
  getPlaybook, putPlaybook, lockPlaybook, embedDocument,
};
