// COGS ASSISTANT + SUPPLIER-QUOTE SCAN — the conversational and document
// doors onto the cost catalog.
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/cogs-assistant', cogsAssistantRoutes);
//
// Same gate as the rest of the costs lane: authenticate +
// requirePermission('funnels','access').
//
// SURFACE
//   POST /chat        {message, images?, model?}      → proposals (INERT)
//   POST /apply       {proposals, kind, batch_id?, …} → writes via appendRate
//   GET  /audit       ?kind&batch_id&limit&offset     → applied batches
//   POST /quote/scan  {file, filename?, model?}       → matrix + verify (INERT)
//   GET  /quote/:id                                   → a stored scan
//
// WHY A SEPARATE FILE. funnelCosts.js owns the cost engine's read/write
// surface and the sibling cost-groups lane owns funnelCostGroups.js. This
// lane adds endpoints and touches neither — coordination by file separation.
// It READS funnelCosts' catalog and CALLS its appendRate; it defines no
// second writer.
//
// THE ONE HARD RULE: /chat and /quote/scan never write a cost. They read the
// catalog, call Claude, and return data. /apply is the only handler that
// reaches appendRate, and it only ever applies proposals the client sent
// back. An Anthropic failure fails the request honestly — 503 with prose —
// and never returns a fabricated extraction.
//
// READ SCOPE (review M8). GET /audit and GET /quote/:id are NOT scoped to the
// requesting user. This deployment is single-org — funnelCostsSchema is
// explicitly "single-tenant", and every sibling surface in the costs lane
// (/funnel-costs/rates, /rates/history, /pnl/*) already shows one operator the
// costs another entered. Per-user scoping HERE and nowhere else would be
// security theatre: the same rate rows, the same amounts and the same
// created_by are one call away on a route this lane does not own. If the app
// ever grows tenants, the fence belongs at the costs lane's edge as a whole,
// not on these two handlers. Stated as a posture, not an oversight.
import { Router, json } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { ensureFunnelCostsTables } from '../services/funnelCostsSchema.js';
import { ensureCogsAssistantTables } from '../services/cogsAssistantSchema.js';
import { CostError } from '../services/funnelCosts.js';
import {
  loadCatalogContext, membershipFor, cleanProposals, applyProposals, listAudit,
  saveQuoteScan, getQuoteScan, priorScansOf, matchVariant, sha256, newBatchId,
  quoteBlockedRows, MAX_OPS_PER_BATCH, MAX_MESSAGE_CHARS,
  MODEL_ALLOWLIST, DEFAULT_MODEL,
} from '../services/cogsAssistant.js';
import { runChat, validateImages } from '../services/cogsAssistantChat.js';
import {
  decodeUpload, extractQuoteMatrix, MAX_UPLOAD_BYTES,
} from '../services/quoteExtract.js';
import { ExtractError, verifyMatrix, demoteModelZeros } from '../services/quoteVerify.js';

const router = Router();

// ── this router parses its OWN body ────────────────────────────────────────
// Same pattern and reason as routes/media.js: a route-level cap is only real
// if this router is mounted BEFORE the app-level express.json. It is not
// today (routes/index.js mounts behind it), so this line is a ceiling that
// cannot fire yet and the DECODED cap in decodeUpload is what actually holds.
// 14mb: a 10mb file is ~13.4mb of base64 plus the JSON envelope.
router.use(json({ limit: '14mb' }));
router.use(authenticate, requirePermission('funnels', 'access'));

router.use(async (req, res, next) => {
  try {
    await ensureFunnelCostsTables();
    await ensureCogsAssistantTables();
    next();
  } catch (err) {
    next(err);
  }
});

// ── error boundary ─────────────────────────────────────────────────────────
// ExtractError.detail is for the LOG ONLY. An upstream SDK error message can
// echo request context — including the provider key — so only .code and our
// own prose cross the wire.
const EXTRACT_STATUS = {
  ai_unconfigured: 503,
  ai_unavailable: 503,
  assistant_truncated: 502,
  extraction_refused: 422,
  file_too_large: 413,
  image_too_large: 413,
  bad_model: 422,
};

const fail = (res, status, code, message) =>
  res.status(status).json({ success: false, error: { code, ...(message ? { message } : {}) } });

const guard = (name, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ExtractError) {
      const status = EXTRACT_STATUS[err.code] || 422;
      if (err.detail) console.error(`[cogsAssistant] ${name} ${err.code}:`, String(err.detail).slice(0, 300));
      return fail(res, status, err.code, err.message);
    }
    if (err instanceof CostError) {
      return fail(res, 422, err.code);
    }
    console.error(`[cogsAssistant] ${name} failed:`, err && err.message ? err.message : err);
    return fail(res, 500, 'internal_error');
  }
};

const userId = (req) => String((req.user && (req.user.email || req.user.id)) || '');
const pickModel = (v) => {
  if (v === undefined || v === null || v === '') return DEFAULT_MODEL;
  const m = String(v);
  if (!MODEL_ALLOWLIST.includes(m)) throw new ExtractError('bad_model', `model must be one of: ${MODEL_ALLOWLIST.join(', ')}`);
  return m;
};

// Per-user limits on the two endpoints that spend money upstream. Keyed on
// the user, not the IP — this surface is authenticated and a whole office
// shares one egress IP. Fail-open, like the rest of the repo's limiter use.
const DEFAULT_RATE_LIMIT = 20;
const AI_WINDOW_SEC = 5 * 60;

// Read at CALL time, not module load — the same reason media.js does it: an
// operator raising the ceiling mid-session should not need a redeploy, and the
// harness needs to drive both sides of the limit in one process. Garbage falls
// back to the default rather than disabling the limit.
function rateLimit() {
  const raw = process.env.COGS_ASSISTANT_RATE_LIMIT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_RATE_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RATE_LIMIT;
  return Math.trunc(n);
}

async function rateLimited(req, res, bucket) {
  const who = req.user?.id || req.ip || 'unknown';
  const { allowed, retryAfter } = await checkRateLimit(`cogs-asst:${bucket}:${who}`, rateLimit(), AI_WINDOW_SEC)
    .catch(() => ({ allowed: true }));
  if (allowed) return false;
  res.set('Retry-After', String(retryAfter || AI_WINDOW_SEC));
  fail(res, 429, 'rate_limited', 'Too many AI requests — try again in a few minutes');
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /chat — conversational COGS entry. WRITES NOTHING.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/chat', guard('chat', async (req, res) => {
  if (await rateLimited(req, res, 'chat')) return;
  const b = req.body || {};
  const message = String(b.message == null ? '' : b.message);
  if (message.length > MAX_MESSAGE_CHARS) {
    return fail(res, 422, 'message_too_long', `message exceeds ${MAX_MESSAGE_CHARS} characters`);
  }
  const images = validateImages(b.images);
  if (!message.trim() && !images.length) {
    return fail(res, 422, 'empty_request', 'type something, or attach a photo of the price list');
  }
  const model = pickModel(b.model);

  const catalog = await loadCatalogContext();
  // An empty catalog is answered WITHOUT burning a call — the operator needs
  // the detection sweep, not a model.
  if (!catalog.items.length) {
    return res.json({
      success: true,
      data: {
        proposals: [], dropped: [], unmatched: [],
        questions: ['No variants have been detected yet — run the detection sweep on the Costs tab first.'],
        summary: 'Catalog is empty', source: images.length ? 'image' : 'chat',
        catalog_count: 0, catalog_truncated: false, model: '', usage: {},
        batch_id: newBatchId(),
      },
    });
  }

  const out = await runChat({ message, images, catalog, model });
  const source = images.length ? 'image' : 'chat';
  // THE HALLUCINATION GATE + carry-forward + preview, in one pass.
  const { proposals, dropped } = cleanProposals(out.raw_proposals, {
    byId: catalog.byId, itemIds: catalog.itemIds, source, carry: true,
  });

  res.json({
    success: true,
    data: {
      proposals,
      dropped,
      unmatched: out.unmatched,
      questions: out.questions,
      summary: out.summary,
      source,
      catalog_count: catalog.total,
      catalog_truncated: catalog.truncated,
      model: out.model,
      usage: out.usage,
      // One batch id per turn, minted here so the audit row and every rate the
      // turn writes carry the same key even if the operator applies in pieces.
      batch_id: newBatchId(),
    },
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /apply — THE ONLY WRITE. Every rate goes through appendRate.
// ═══════════════════════════════════════════════════════════════════════════
// Re-validates against a FRESHLY read catalog: the proposals have made a
// round trip through a browser and the sweep may have moved under them.
router.post('/apply', guard('apply', async (req, res) => {
  // Rate-limited too (review M5). It writes to the money path and its own
  // bucket, so a runaway client cannot burn the AI budget and the ledger with
  // one loop. Fail-open, like the rest of the repo's limiter use.
  if (await rateLimited(req, res, 'apply')) return;
  const b = req.body || {};
  const raw = b.proposals;
  if (!Array.isArray(raw) || !raw.length) {
    return fail(res, 422, 'proposals_required', 'send at least one proposal');
  }
  if (raw.length > MAX_OPS_PER_BATCH) {
    return fail(res, 422, 'too_many_proposals', `at most ${MAX_OPS_PER_BATCH} proposals per batch`);
  }
  const kind = b.kind === 'quote' ? 'quote' : 'chat';
  const batchId = b.batch_id === undefined || b.batch_id === null || b.batch_id === ''
    ? null : String(b.batch_id);
  if (batchId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(batchId)) {
    return fail(res, 422, 'bad_batch_id', 'batch_id must be 1-64 chars of [A-Za-z0-9_-]');
  }
  const quoteScanId = b.quote_scan_id ? String(b.quote_scan_id).slice(0, 64) : null;

  // THE VERIFIER RE-RUNS SERVER-SIDE FOR QUOTE-SOURCED OPS (review M3).
  // A quote apply must name its scan, because the scan is the only copy of the
  // matrix the client cannot edit. quoteBlockedRows re-runs verifyMatrix over
  // that stored matrix and unions the result with the findings recorded at scan
  // time, so a row the verifier blocked stays blocked whatever the browser
  // sends. The client can never overrule the verifier.
  let verifyBlocked = null;
  if (kind === 'quote') {
    if (!quoteScanId) {
      return fail(res, 422, 'quote_scan_id_required',
        'a quote apply must name the scan it came from');
    }
    const scan = await getQuoteScan(quoteScanId);
    if (!scan) return fail(res, 422, 'unknown_quote_scan', 'that scan id does not exist');
    verifyBlocked = quoteBlockedRows(scan);
  } else if (quoteScanId && !(await getQuoteScan(quoteScanId))) {
    return fail(res, 422, 'unknown_quote_scan', 'that scan id does not exist');
  }

  // Membership for exactly the refs in this request — not the whole grid,
  // which clamps and would reject a legitimate proposal for a low-revenue
  // variant that fell off the propose-time page. It carries the RESOLVED
  // unit_cogs/ship, which is what carry-forward reads.
  const refs = raw
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      scope: p.scope === 'item' ? 'item' : 'variant',
      ref: String((p.scope === 'item' ? p.cost_item_id : p.variant_id) || ''),
    }));
  const live = await membershipFor(refs);

  // carry:TRUE (review B2). It was false here, and that was the bug: a quote
  // row whose cost was unreadable — or whose 0 MODEL_ZERO had just demoted to
  // null — wrote `unit_cogs: null` straight over a real cost. Carrying against
  // the state we just read means a null NEVER overwrites a non-null resolved
  // value; only an explicit_clear does, and that is a deliberate act the plan
  // table shows in red.
  // dedupe:false — two entries for one variant are a legitimate "set the cost,
  // and also the ship" assembled across turns; applyProposals' groupWrites
  // MERGES them into one row rather than dropping the second.
  const { proposals, dropped } = cleanProposals(raw, {
    byId: live.byId, itemIds: live.itemIds, items: live.items,
    source: kind === 'quote' ? 'image' : 'chat',
    carry: true, dedupe: false, verifyBlocked,
  });
  if (!proposals.length) {
    return res.status(422).json({
      success: false,
      error: { code: 'nothing_applicable' },
      data: { dropped },
    });
  }

  const out = await applyProposals({
    proposals,
    kind,
    model: String(b.model || '').slice(0, 64),
    sourceText: String(b.source_text || '').slice(0, 4000),
    quoteScanId,
    createdBy: userId(req),
    batchId,
    note: String(b.note || '').slice(0, 500),
  });

  res.json({ success: true, data: { ...out, dropped } });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /audit — who applied what, when, off which proposal and which model
// ═══════════════════════════════════════════════════════════════════════════
router.get('/audit', guard('audit', async (req, res) => {
  const out = await listAudit({
    kind: req.query.kind ? String(req.query.kind) : null,
    batchId: req.query.batch_id ? String(req.query.batch_id) : null,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ success: true, data: out });
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /quote/scan — upload → vision → matrix → verify. WRITES NO COST.
// ═══════════════════════════════════════════════════════════════════════════
// Persists the extracted matrix and a sha256 of the bytes. The file itself is
// decoded in memory, sniffed, sent, and dropped.
router.post('/quote/scan', guard('quote-scan', async (req, res) => {
  if (await rateLimited(req, res, 'scan')) return;
  const b = req.body || {};
  const model = pickModel(b.model);
  const { buf, contentType, filename } = decodeUpload({
    data: b.file ?? b.data, filename: b.filename,
  });
  const hash = sha256(buf);
  const prior = await priorScansOf(hash);

  const catalog = await loadCatalogContext();
  const extracted = await extractQuoteMatrix({ buf, contentType, model, catalog });

  // VERIFY FIRST, then demote. The MODEL_ZERO finding must reach the operator
  // even though the value it describes is about to become null.
  const verify = verifyMatrix({ header: extracted.header, rows: extracted.rows });
  let rows = demoteModelZeros(extracted.rows);

  // Seed a catalog match per row so the editable table opens with a suggestion
  // instead of a blank column. Nothing is auto-selected: `selected` stays
  // false and the operator ticks the rows they accept.
  rows = rows.map((r) => {
    const m = matchVariant(r.label, catalog.items);
    return {
      ...r,
      variant_id: m.variant_id,
      match_confidence: m.confidence,
      match_reason: m.reason,
      match_alternatives: m.alternatives,
      blocked: verify.blocked_row_ids.includes(r.row_id),
    };
  });

  const scan = await saveQuoteScan({
    contentHash: hash,
    contentType,
    byteSize: buf.length,
    filename,
    model: extracted.model,
    header: extracted.header,
    matrix: rows,
    verify,
    createdBy: userId(req),
  });

  res.json({
    success: true,
    data: {
      scan_id: scan.id,
      content_hash: hash,
      content_type: contentType,
      byte_size: buf.length,
      filename,
      header: extracted.header,
      rows,
      unreadable: extracted.unreadable,
      verify,
      model: extracted.model,
      catalog_count: catalog.total,
      catalog_truncated: catalog.truncated,
      prior_scans: prior.map((p) => ({ id: p.id, created_at: p.created_at, created_by: p.created_by })),
      batch_id: newBatchId(),
    },
  });
}));

// GET /quote/:id — re-open a stored scan without re-paying for the vision
// call. The matrix is the record; the file is gone.
router.get('/quote/:id', guard('quote-get', async (req, res) => {
  const row = await getQuoteScan(req.params.id);
  if (!row) return fail(res, 404, 'not_found');
  res.json({ success: true, data: row });
}));

// GET /limits — what the client should enforce before it uploads.
router.get('/limits', guard('limits', async (req, res) => {
  res.json({
    success: true,
    data: {
      max_upload_bytes: MAX_UPLOAD_BYTES,
      max_proposals: MAX_OPS_PER_BATCH,
      max_message_chars: MAX_MESSAGE_CHARS,
      models: MODEL_ALLOWLIST,
      default_model: DEFAULT_MODEL,
    },
  });
}));

export default router;
