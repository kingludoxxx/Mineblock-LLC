// THE STORE BRAIN — layer-2 extraction. An LLM PROPOSES, a human approves.
//
// The one invariant this file exists to hold: nothing it writes is ever
// `approved`. It creates insights through brainStore.createInsight, which hard-
// codes status 'proposed' and requires provenance, so there is no code path here
// that could bless its own output (R16).
//
// The client is INJECTABLE (`clientFactory`), the same seam quoteExtract.js uses,
// so the tests drive the whole job with a mocked model and no network.

import { BrainError } from './brain/brainSchema.js';
import { createInsight } from './brainStore.js';
import { INSIGHT_TYPES } from './brain/brainSchema.js';

export const DEFAULT_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

const EXTRACT_TOOL = {
  name: 'emit_insights',
  description: 'Emit the typed facts this document actually supports. Nothing inferred, nothing invented.',
  input_schema: {
    type: 'object',
    properties: {
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            insight_type: { type: 'string', enum: [...INSIGHT_TYPES] },
            body: { type: 'string', description: 'the fact, in one sentence' },
            quote: { type: 'string', description: 'verbatim excerpt from the document, when there is one' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['insight_type', 'body'],
        },
      },
    },
    required: ['insights'],
  },
};

const SYSTEM = [
  'You read one captured document and emit the typed facts it SUPPORTS.',
  'Quote the document verbatim wherever a customer said it.',
  'Emit nothing the document does not state. An empty list is a valid answer.',
  'You are proposing for human review; you are not deciding anything.',
].join(' ');

/**
 * Run one extraction job over one document.
 * @returns {{jobId:number, proposed:number, model:string, insightIds:number[]}}
 * @throws  BrainError('ai_unconfigured'|'ai_unavailable'|'not_found') — a failure
 *          is VISIBLE. An empty proposal set would be indistinguishable from
 *          "this document had nothing in it", which is the bug to avoid.
 */
export async function runExtraction(sql, { documentId, clientFactory = null, model = DEFAULT_EXTRACT_MODEL, actor = null } = {}) {
  const id = Number.parseInt(documentId, 10);
  if (!Number.isFinite(id)) throw new BrainError('bad_id', 'document_id must be an integer');
  const [doc] = await sql`SELECT id, title, body_text, product_code FROM kb_documents WHERE id = ${id}`;
  if (!doc) throw new BrainError('not_found', `no document ${id} in this store's Brain`, 404);

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new BrainError('ai_unconfigured', 'insight extraction is not configured (ANTHROPIC_API_KEY missing)', 503);
  }

  const [job] = await sql`
    INSERT INTO kb_extraction_jobs (document_id, status, model, created_by)
    VALUES (${doc.id}, 'running', ${model}, ${actor ? String(actor) : null})
    RETURNING id`;

  let client;
  if (clientFactory) {
    client = clientFactory();
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
  }

  let message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [EXTRACT_TOOL],
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `${doc.title ? `${doc.title}\n\n` : ''}${String(doc.body_text).slice(0, 60000)}` }],
      }],
    });
  } catch (err) {
    const msg = err?.message || String(err);
    await sql`UPDATE kb_extraction_jobs SET status = 'failed', error = ${msg}, finished_at = NOW() WHERE id = ${job.id}`;
    throw new BrainError('ai_unavailable', `the model could not be reached for this extraction: ${msg}`, 503, msg);
  }

  const toolUse = (message?.content || []).find((b) => b && b.type === 'tool_use' && b.name === EXTRACT_TOOL.name);
  if (!toolUse) {
    const prose = (message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    await sql`UPDATE kb_extraction_jobs SET status = 'failed', error = ${prose || 'no tool call'}, finished_at = NOW() WHERE id = ${job.id}`;
    throw new BrainError('extraction_refused', prose || 'the model emitted no insights tool call', 422);
  }

  const proposals = Array.isArray(toolUse.input?.insights) ? toolUse.input.insights : [];
  const insightIds = [];
  for (const p of proposals) {
    const insight = await createInsight(sql, {
      insight_type: p.insight_type,
      product_code: doc.product_code,
      body: p.body,
      quote: p.quote,
      confidence: p.confidence,
      source_document_ids: [doc.id],
    }, { actor: `llm:${model}`, extractionJobId: job.id });
    insightIds.push(Number(insight.id));
  }
  await sql`UPDATE kb_extraction_jobs SET status = 'done', proposed_count = ${insightIds.length}, finished_at = NOW() WHERE id = ${job.id}`;
  return { jobId: Number(job.id), proposed: insightIds.length, model, insightIds };
}

export default { runExtraction, DEFAULT_EXTRACT_MODEL };
