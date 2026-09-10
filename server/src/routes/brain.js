// THE STORE BRAIN — the ONE internal API per store.
//
//   GET    /api/v1/brain/search              semantic or keyword + filters, citations
//   GET    /api/v1/brain/documents/:id       one raw document
//   GET    /api/v1/brain/documents           list (filters)
//   POST   /api/v1/brain/ingest              idempotent by content hash
//   GET    /api/v1/brain/insights            list (status / type / product)
//   POST   /api/v1/brain/insights            propose (never approved)
//   PATCH  /api/v1/brain/insights/:id        approve / reject
//   POST   /api/v1/brain/extract             LLM proposes insights for a document
//   GET    /api/v1/brain/playbook/:product   curated layer
//   PUT    /api/v1/brain/playbook/:product   written only through here
//   POST   /api/v1/brain/playbook/:product/lock
//
// There is NO store parameter on any of these routes, by design: the API runs
// inside one store's dashboard against that store's database, so retrieval is
// scoped by construction. Auth is a dashboard session (brain:access) OR that
// pair's own service token.
//
// R15: nothing here names a product, store or brand. Product codes arrive as
// data and are validated against PRODUCT_CODES_JSON.

import { Router } from 'express';
import { client as sql } from '../db/pg.js';
import brainAuth from '../middleware/brainAuth.js';
import { BrainError } from '../services/brain/brainSchema.js';
import { StoreConfigError } from '../config/storeConfig.js';
import {
  ingestDocument, getDocument, listDocuments,
  createInsight, listInsights, setInsightStatus,
  getPlaybook, putPlaybook, lockPlaybook, embedDocument,
} from '../services/brainStore.js';
import { search } from '../services/brainSearch.js';
import { runExtraction } from '../services/brainExtract.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(brainAuth);

/** One error shape for the whole surface. An unexpected error is a 500, logged. */
function fail(res, err, where) {
  if (err instanceof BrainError) {
    return res.status(err.status).json({ error: err.message, code: err.code, detail: err.detail || undefined });
  }
  if (err instanceof StoreConfigError) {
    return res.status(503).json({ error: err.message, code: 'store_config' });
  }
  logger.error(`brain ${where} failed`, { message: err?.message });
  return res.status(500).json({ error: 'Brain request failed', code: 'internal' });
}

const wrap = (where, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { fail(res, err, where); }
};

// ── search ─────────────────────────────────────────────────────────────────
router.get('/search', wrap('search', async (req, res) => {
  const out = await search(sql, req.query);
  res.json(out);
}));

// ── raw documents ──────────────────────────────────────────────────────────
router.get('/documents', wrap('documents.list', async (req, res) => {
  res.json(await listDocuments(sql, req.query));
}));

router.get('/documents/:id', wrap('documents.get', async (req, res) => {
  res.json({ document: await getDocument(sql, req.params.id) });
}));

router.post('/ingest', wrap('ingest', async (req, res) => {
  const body = req.body || {};
  // A caller may hand over an R2 object reference instead of text; the text is
  // still what gets indexed, so it is required either way.
  const { document, created } = await ingestDocument(sql, body, { actor: req.brainActor || null });

  if (created) {
    // Best effort, never fatal: the bucket is the archive, the database is the index.
    try {
      const { isR2Configured, uploadBuffer } = await import('../services/r2.js');
      if (isR2Configured() && document.body_object_key && !body.body_object_key) {
        await uploadBuffer(Buffer.from(document.body_text, 'utf8'), document.body_object_key, document.content_type);
      }
    } catch (err) {
      logger.warn('brain ingest: raw body not mirrored to the bucket', { message: err?.message, key: document.body_object_key });
    }
    try {
      await embedDocument(sql, document.id);
    } catch (err) {
      logger.warn('brain ingest: document not embedded (keyword search still indexes it)', { message: err?.message });
    }
  }
  res.status(created ? 201 : 200).json({ created, document });
}));

// ── insights ───────────────────────────────────────────────────────────────
router.get('/insights', wrap('insights.list', async (req, res) => {
  res.json(await listInsights(sql, req.query));
}));

router.post('/insights', wrap('insights.create', async (req, res) => {
  const insight = await createInsight(sql, req.body || {}, { actor: req.brainActor || null });
  res.status(201).json({ insight });
}));

router.patch('/insights/:id', wrap('insights.patch', async (req, res) => {
  const { status, reason } = req.body || {};
  const insight = await setInsightStatus(sql, req.params.id, status, {
    actor: req.brainActor || null, reason,
  });
  res.json({ insight });
}));

// ── extraction (proposes; never approves) ──────────────────────────────────
router.post('/extract', wrap('extract', async (req, res) => {
  const { document_id: documentId, model } = req.body || {};
  const out = await runExtraction(sql, {
    documentId, model: model || undefined, actor: req.brainActor || null,
  });
  res.status(202).json(out);
}));

// ── playbook ───────────────────────────────────────────────────────────────
router.get('/playbook/:product', wrap('playbook.get', async (req, res) => {
  res.json({ playbook: await getPlaybook(sql, req.params.product) });
}));

router.put('/playbook/:product', wrap('playbook.put', async (req, res) => {
  const playbook = await putPlaybook(sql, req.params.product, req.body || {}, { actor: req.brainActor || null });
  res.json({ playbook });
}));

router.post('/playbook/:product/lock', wrap('playbook.lock', async (req, res) => {
  res.json({ playbook: await lockPlaybook(sql, req.params.product, { actor: req.brainActor || null }) });
}));

export default router;
