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
  contentHash, rawObjectKey, clampLimit, BODY_MAX_BYTES, extForContentType, CONTENT_TYPES,
} from './brain/brainSchema.js';
import { storeCode } from '../config/storeConfig.js';
import { getEmbeddingProvider, vectorColumnAvailable, toVectorLiteral } from './brain/embeddingProvider.js';
import { requireReadScope, assertMayReadUnapproved, APPROVED } from './brain/brainScope.js';

/**
 * NEW-4: the on-demand backfill runs INSIDE a web request, so it is bounded by a
 * number a reader can see rather than by how far behind the index happens to be.
 * Ten embeddings is roughly one extra second on the p50 provider latency and ten
 * units of spend; a Brain with a large backlog catches up over several queries.
 * Full per-store metering (R18) is a queued item — see docs/BRAIN.md.
 */
export const BACKFILL_MAX_PER_REQUEST = 10;

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

  // P1-6: the object key is SERVER-DERIVED and nothing else. Both of these used
  // to reach the key verbatim, and the key is what the ingest route uploads to
  // and what a future signed-URL route would read back:
  //   ext: 'txt/../../../../brand-spy/videos/owned'  → a key outside the
  //        convention whose R2_PUBLIC_URL form a browser normalises elsewhere
  //   body_object_key: '../../../other-store/secret.txt' → stored verbatim
  // Refusing them LOUDLY (422) beats silently ignoring them: a caller that sends
  // one has a wrong model of who owns the key and needs to hear so.
  if (input.body_object_key !== undefined && input.body_object_key !== null) {
    throw new BrainError('key_not_yours',
      'body_object_key is derived by the server from the content hash — it cannot be supplied by the caller', 422);
  }
  if (input.ext !== undefined && input.ext !== null) {
    throw new BrainError('ext_not_yours',
      `ext is derived from content_type — send content_type instead (one of: ${CONTENT_TYPES.join(', ')})`, 422);
  }
  extForContentType(contentType); // 422 on an unarchivable type, before any write
  const key = rawObjectKey({ source, capturedAt, hash, contentType, storeCode: storeCode() });

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

/**
 * List insights.
 *
 * NEW-1: this function had no reference to the actor at all and its DEFAULT was
 * every status, so the pipeline credential read the PROPOSED and REJECTED layers
 * — full bodies, quotes and citations — through the door nobody had re-checked
 * after `/search` was fixed. The scope is now MANDATORY (`requireReadScope`), so
 * a route cannot reach this code without saying who is asking.
 *
 * Without `brain:approve`: the answer is the approved layer, and an explicit
 * `?status=proposed|rejected` is refused 403 `approval_scope` rather than
 * silently narrowed — a review queue that is quietly empty is worse than one
 * that says "you may not see this".
 */
export async function listInsights(sql, filters = {}, ctx) {
  const scope = requireReadScope(ctx);
  const limit = clampLimit(filters.limit);
  const product = assertProductCode(filters.product ?? null);
  const requested = filters.status ? assertStatus(filters.status) : null;
  if (!scope.mayReadUnapproved && requested && requested !== APPROVED) {
    assertMayReadUnapproved(scope, `status=${requested}`);
  }
  const status = scope.mayReadUnapproved ? requested : APPROVED;
  const type = filters.insight_type ? assertInsightType(filters.insight_type) : null;
  const rows = await sql`
    SELECT * FROM kb_insights
    WHERE (${product}::text IS NULL OR product_code = ${product})
      AND (${status}::text IS NULL OR status = ${status})
      AND (${type}::text IS NULL OR insight_type = ${type})
    ORDER BY id DESC
    LIMIT ${limit}`;
  const cites = await citationsFor(sql, rows.map((r) => Number(r.id)));
  return {
    insights: rows.map((r) => ({ ...withNumericIds(r), citations: cites.get(Number(r.id)) || [] })),
    limit,
    // What the caller actually got, stated rather than implied: a pipeline that
    // asks for "the insights" is told it received the approved layer.
    status: status ?? 'any',
    approved_only: !scope.mayReadUnapproved,
  };
}

/** A v4-shaped uuid — what `users.id` is. Not a claim that the row exists. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Approve or reject.
 *
 * P0-2: "the actor is a non-empty string" was the whole gate, so the per-pair
 * SERVICE token — the credential that exists so a pipeline can READ — approved
 * insights and stamped `approved_by = "service"`. An approval is a human act:
 * `userId` must be a real dashboard user id, and it is what lands in
 * `approved_by`. A rejection records the same id and KEEPS its reason.
 */
export async function setInsightStatus(sql, id, status, { actor = null, userId = null, reason = null } = {}) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) throw new BrainError('bad_id', 'insight id must be an integer');
  const s = assertStatus(status);
  if (s === 'proposed') throw new BrainError('bad_status', 'an insight cannot be moved back to proposed; create a new one');
  if (!trimOrNull(actor)) throw new BrainError('no_actor', 'an approval must record who made it', 401);
  const uid = trimOrNull(userId);
  if (!uid || !UUID_RE.test(uid)) {
    throw new BrainError('no_reviewer',
      'approving or rejecting an insight requires a dashboard user — a service credential cannot review its own inputs', 403);
  }
  const [user] = await sql`SELECT id FROM users WHERE id = ${uid}::uuid LIMIT 1`;
  if (!user) throw new BrainError('no_reviewer', 'the reviewing user does not exist in this store', 403);
  // P2-8 — DECISION MADE: KEEP the history, do not refuse the transition.
  // `rejected → approved` used to NULL `rejected_reason`, so the record of WHY a
  // claim had once been withdrawn vanished the moment someone re-approved it, and
  // the next reviewer could not see that the question had already been asked.
  // Refusing the transition instead would be wrong: a rejection corrected by new
  // evidence is normal review. So every transition appends to
  // `metadata.review_history` — the old status, the old rejection reason, who did
  // it and when — and `rejected_reason` still means "why it is rejected RIGHT
  // NOW". No new migration: `metadata` is jsonb and has been there since 128.
  // The column references in the SET list below are the row's OLD values, which is
  // exactly what the history needs.
  const rows = await sql`
    UPDATE kb_insights
    SET status = ${s},
        approved_by = ${s === 'approved' ? uid : null},
        approved_at = ${s === 'approved' ? new Date() : null},
        rejected_reason = ${s === 'rejected' ? trimOrNull(reason) : null},
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb), '{review_history}',
          COALESCE(metadata -> 'review_history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'at', to_jsonb(NOW()),
            'by', ${uid}::text,
            'from', status,
            'to', ${s}::text,
            'reason', ${trimOrNull(reason)}::text,
            'rejected_reason_before', rejected_reason))),
        updated_at = NOW()
    WHERE id = ${n}
    RETURNING *`;
  if (!rows.length) throw new BrainError('not_found', `no insight ${n} in this store's Brain`, 404);
  return withNumericIds(rows[0]);
}

// ── Layer 3: PLAYBOOK ───────────────────────────────────────────────────────

/**
 * Read the playbook.
 *
 * NEW-3 — citations were validated only at WRITE time (P1-5's 422), so an insight
 * approved on Monday, cited into a playbook, locked, and REJECTED on Tuesday was
 * still cited by that locked version on Wednesday. A pipeline copying `cites` into
 * its run manifest was then citing a withdrawn claim, which is the approval gate
 * defeated by outliving it.
 *
 * DECISION MADE — DROP AND FLAG, for every reader alike (a reviewer needs to see
 * the breakage as much as a pipeline needs not to inherit it):
 *   `cites`        only insights that are approved RIGHT NOW. Safe to put in a
 *                  manifest without asking a second question.
 *   `stale_cites`  the rest, each with the status that disqualified it
 *                  (`proposed`, `rejected`, or `missing` if the row is gone), so
 *                  the entry is visibly in need of a re-review rather than
 *                  silently thinner than it was.
 * The alternative — refusing to reject a cited insight — was rejected: it lets a
 * playbook entry veto a review decision, which is the wrong way round.
 */
export async function getPlaybook(sql, productCodeIn) {
  const productCode = assertProductCode(productCodeIn, { required: true });
  const head = await sql`SELECT * FROM playbook_products WHERE product_code = ${productCode} LIMIT 1`;
  const entries = await sql`
    SELECT e.*, COALESCE(
      (SELECT json_agg(json_build_object('id', c.insight_id, 'status', i.status) ORDER BY c.insight_id)
         FROM playbook_citations c
         LEFT JOIN kb_insights i ON i.id = c.insight_id
        WHERE c.entry_id = e.id),
      '[]'::json) AS cite_rows
    FROM playbook_entries e WHERE e.product_code = ${productCode}
    ORDER BY e.section, e.position, e.id`;
  const sections = {};
  for (const e of entries) {
    const citeRows = e.cite_rows || [];
    (sections[e.section] ||= []).push({
      key: e.entry_key,
      position: e.position,
      value: e.value,
      cites: citeRows.filter((c) => c.status === APPROVED).map((c) => Number(c.id)),
      stale_cites: citeRows.filter((c) => c.status !== APPROVED)
        .map((c) => ({ insight_id: Number(c.id), status: c.status || 'missing' })),
      updated_by: e.updated_by,
      updated_at: e.updated_at,
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
  // P1-5: EXISTS was the whole citation check, so layer 3 — the layer pipelines
  // actually read — could carry an unapproved insight through its citation, which
  // is the approval gate defeated by the back door. A cited insight must be
  // APPROVED, and the refusal names which ones were not and what status they hold.
  const allCites = [...new Set(normalised.flatMap((e) => e.cites))];
  if (allCites.length) {
    const found = await sql`SELECT id, status FROM kb_insights WHERE id = ANY(${sql.array(allCites)}::bigint[])`;
    const byId = new Map(found.map((r) => [Number(r.id), r.status]));
    const missing = allCites.filter((id) => !byId.has(id));
    if (missing.length) throw new BrainError('bad_citation', `cited insight(s) not in this store's Brain: ${missing.join(', ')}`);
    const unapproved = allCites.filter((id) => byId.get(id) !== 'approved');
    if (unapproved.length) {
      throw new BrainError('citation_not_approved',
        `the playbook may only cite APPROVED insights — ${unapproved.map((id) => `${id} is ${byId.get(id)}`).join(', ')}`, 422);
    }
  }

  // P1-4: the lock was decorative — putPlaybook never read `locked_at`, so a
  // write after a lock rewrote the content, bumped the version, and LEFT the old
  // lock stamp in place, so the head row asserted a lock it no longer described.
  // A locked playbook refuses the write (423) and the version does NOT move;
  // changing it needs an explicit unlock, which is a brain:approve act.
  //
  // NEW-2: the check above used to be its OWN statement, outside the transaction
  // that then did the writing, so a LOCK committing in the gap was invisible to it
  // and the write went through — a locked version whose content changed after the
  // stamp, which is P1-4's harm restored by a race. The head row is now read
  // INSIDE the transaction and `FOR UPDATE`: a concurrent lock either committed
  // first (and this write sees it and refuses) or it blocks on the row until this
  // write commits (and then locks the version it actually locked). There is no
  // third interleaving.
  await sql.begin(async (tx) => {
    const [head] = await tx`
      SELECT version, locked_at, locked_by FROM playbook_products
      WHERE product_code = ${productCode} FOR UPDATE`;
    if (head?.locked_at) {
      throw new BrainError('playbook_locked',
        `playbook version ${head.version} is LOCKED (by ${head.locked_by || 'unknown'} at ${new Date(head.locked_at).toISOString()}) — unlock it before writing`,
        423);
    }
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

/**
 * Lock the current version: what a pipeline run quotes in its manifest (R16).
 * While locked, `putPlaybook` refuses (423), so the locked version's CONTENT is
 * fixed and a run manifest that names it means something. Re-locking an already
 * locked playbook is refused rather than silently re-stamping `locked_at`.
 */
export async function lockPlaybook(sql, productCodeIn, { actor = null } = {}) {
  const productCode = assertProductCode(productCodeIn, { required: true });
  // NEW-2, same shape as putPlaybook: check and stamp under one row lock. Two
  // concurrent locks serialising 200/423 was luck before; now it is the rule, and
  // a lock taken while a PUT is in flight waits for that PUT rather than stamping
  // a version whose content is still moving.
  await sql.begin(async (tx) => {
    const [head] = await tx`
      SELECT version, locked_at, locked_by FROM playbook_products
      WHERE product_code = ${productCode} FOR UPDATE`;
    if (!head) throw new BrainError('not_found', `no playbook for ${productCode}`, 404);
    if (head.locked_at) {
      throw new BrainError('playbook_locked',
        `playbook version ${head.version} is already locked (by ${head.locked_by || 'unknown'} at ${new Date(head.locked_at).toISOString()})`,
        423);
    }
    await tx`
      UPDATE playbook_products SET locked_at = NOW(), locked_by = ${trimOrNull(actor)}, updated_at = NOW()
      WHERE product_code = ${productCode}`;
  });
  return getPlaybook(sql, productCode);
}

/**
 * Release the lock. Editing a locked playbook is a deliberate act, so it is
 * separate from the write and gated on brain:approve at the route. The version
 * does NOT move here: unlocking changes no content.
 */
export async function unlockPlaybook(sql, productCodeIn, { actor = null } = {}) {
  const productCode = assertProductCode(productCodeIn, { required: true });
  await sql.begin(async (tx) => {
    const [head] = await tx`
      SELECT locked_at FROM playbook_products WHERE product_code = ${productCode} FOR UPDATE`;
    if (!head) throw new BrainError('not_found', `no playbook for ${productCode}`, 404);
    if (!head.locked_at) throw new BrainError('playbook_not_locked', `the playbook for ${productCode} is not locked`, 409);
    await tx`
      UPDATE playbook_products SET locked_at = NULL, locked_by = NULL, updated_at = NOW()
      WHERE product_code = ${productCode}`;
  });
  logUnlock(productCode, actor);
  return getPlaybook(sql, productCode);
}

/** An unlock is rare and consequential — it is always on the record. */
function logUnlock(productCode, actor) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'brain.playbook.unlock', product_code: productCode, actor: actor || null, at: new Date().toISOString() }));
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

/**
 * Embed ONE insight into `kb_embeddings.insight_id`.
 *
 * P0-1: nothing anywhere wrote `insight_id`. `embedDocument` was the only writer
 * and it always wrote `document_id`, while the vector search joins
 * `kb_embeddings e JOIN kb_insights i ON i.id = e.insight_id` — always zero rows.
 * Keyword mode reads `search_tsv` and worked, so the entire approval layer was
 * visible on the no-pgvector cluster the lane tested on and INVISIBLE on the
 * pgvector shape production runs, with no error: a pipeline asking for approved
 * insights got `[]`, which reads exactly like "this store has none".
 */
export async function embedInsight(sql, insightId, { provider = getEmbeddingProvider() } = {}) {
  if (!provider) return { embedded: false, reason: 'no embedding provider configured' };
  const [ins] = await sql`SELECT id, body, quote FROM kb_insights WHERE id = ${Number(insightId)}`;
  if (!ins) throw new BrainError('not_found', `no insight ${insightId}`, 404);
  const chunk = [ins.body, ins.quote].filter(Boolean).join('\n').slice(0, 8000);
  const [vec] = await provider.embed([chunk]);
  const hasVector = await vectorColumnAvailable(sql);
  await sql`
    INSERT INTO kb_embeddings (insight_id, chunk_index, chunk_text, provider, model, dim, embedding_json)
    VALUES (${ins.id}, 0, ${chunk}, ${provider.name}, ${provider.model}, ${provider.dim}, ${sql.json(vec)})
    ON CONFLICT (insight_id, chunk_index, model) WHERE insight_id IS NOT NULL
    DO UPDATE SET chunk_text = EXCLUDED.chunk_text, embedding_json = EXCLUDED.embedding_json`;
  if (hasVector) {
    await sql.unsafe(
      'UPDATE kb_embeddings SET embedding = $1::vector WHERE insight_id = $2 AND chunk_index = 0 AND model = $3',
      [toVectorLiteral(vec), ins.id, provider.model],
    );
  }
  return { embedded: true, vector_column: hasVector, dim: provider.dim };
}

/**
 * Embed every insight of the given statuses that has no vector for this model
 * yet, and report the count. Called on the vector search path so a Brain whose
 * insights were approved before this code existed — or while OPENAI_API_KEY was
 * unset — becomes searchable on the next query instead of answering `[]` forever.
 *
 * Bounded per call: a Brain with thousands of unembedded insights catches up over
 * several queries rather than turning one search into a batch job. It RAISES on a
 * provider failure; an incomplete index that answers "nothing matched" is the
 * exact silence this whole fix is about.
 *
 * NEW-4: the bound was 50 and the caller passed nothing, so ONE read request by
 * any holder of the read token could drive 50 provider calls with nothing in the
 * response saying so. The default is now BACKFILL_MAX_PER_REQUEST (10), the search
 * path reports what it spent, and R18 metering stays queued (docs/BRAIN.md).
 */
export async function backfillInsightEmbeddings(sql, { provider = getEmbeddingProvider(), statuses = ['approved'], limit = BACKFILL_MAX_PER_REQUEST } = {}) {
  if (!provider) return { embedded: 0, remaining: 0, limit: 0, reason: 'no embedding provider configured' };
  const pending = await sql`
    SELECT i.id FROM kb_insights i
    WHERE i.status = ANY(${sql.array(statuses)}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM kb_embeddings e
        WHERE e.insight_id = i.id AND e.chunk_index = 0 AND e.model = ${provider.model}
      )
    ORDER BY i.id
    LIMIT ${Math.max(1, Math.min(Number(limit) || BACKFILL_MAX_PER_REQUEST, BACKFILL_MAX_PER_REQUEST))}`;
  let embedded = 0;
  for (const row of pending) {
    await embedInsight(sql, Number(row.id), { provider });
    embedded += 1;
  }
  const [{ n: remaining }] = await sql`
    SELECT count(*)::int AS n FROM kb_insights i
    WHERE i.status = ANY(${sql.array(statuses)}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM kb_embeddings e
        WHERE e.insight_id = i.id AND e.chunk_index = 0 AND e.model = ${provider.model}
      )`;
  return { embedded, remaining, limit: BACKFILL_MAX_PER_REQUEST };
}

export default {
  ingestDocument, getDocument, listDocuments,
  createInsight, listInsights, setInsightStatus, citationsFor,
  getPlaybook, putPlaybook, lockPlaybook, unlockPlaybook,
  embedDocument, embedInsight, backfillInsightEmbeddings,
};
