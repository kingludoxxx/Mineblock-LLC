// PRODUCT BIBLE API — per-market research inside the product library.
//
//   GET  /api/v1/product-bible/products                                  products that have markets
//   GET  /api/v1/product-bible/products/:product/markets                  markets of one product
//   GET  /api/v1/product-bible/products/:product/markets/:market/document read-only document (toc + sections)
//   GET  /api/v1/product-bible/products/:product/markets/:market/entities ?type=&avatar=&angle=&limit=
//   GET  /api/v1/product-bible/products/:product/markets/:market/quotes   ?ids=Q0001,Q0002
//   POST /api/v1/product-bible/context                                    { product, market, avatar?, angle?, job, query?, budget? }
//   POST /api/v1/product-bible/products/:product/markets/:market/import   session only (products:import)
//
// :product is a numeric product id OR a product code / short name (e.g. the code briefs and ClickUp use).
// Auth: a dashboard session with products:access, OR this pair's BRAIN_SERVICE_TOKEN (the CRM's read path).
// The service token is READ-ONLY. Nothing here names a product, market, store or brand (R15).
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { SERVICE_TOKEN_HEADER, tokensMatch } from '../middleware/brainAuth.js';
import { client as sql } from '../db/pg.js';
import {
  BibleError, importMarketBible, listMarkets, listProductsWithMarkets, getBibleDocument, listEntities, getQuotes,
} from '../services/productBible/bibleStore.js';
import { buildBibleContextPack, JOB_BUDGETS } from '../services/productBible/contextPack.js';

const router = Router();

function serviceOrSession(req, res, next) {
  const presented = req.headers[SERVICE_TOKEN_HEADER];
  if (presented !== undefined && String(presented).trim() !== '') {
    const expected = process.env.BRAIN_SERVICE_TOKEN;
    if (!expected || String(expected).length < 16 || String(expected) !== String(expected).trim()) {
      return res.status(503).json({ error: 'Service access is not configured on this store', code: 'service_token_unconfigured' });
    }
    if (!tokensMatch(presented, expected)) return res.status(401).json({ error: 'Invalid service token', code: 'bad_service_token' });
    req.bibleActor = 'service';
    return next();
  }
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return requirePermission('products', 'access')(req, res, (err2) => {
      if (err2) return next(err2);
      req.bibleActor = req.user?.id ? `user:${req.user.id}` : 'user';
      return next();
    });
  });
}

function sessionOnly(req, res, next) {
  if (req.bibleActor === 'service') {
    return res.status(403).json({ error: 'The service token is read-only; importing a bible needs a dashboard session', code: 'service_read_only' });
  }
  return requirePermission('products', 'import')(req, res, next);
}

router.use(serviceOrSession);

export async function resolveProductId(ref, db = sql) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw new BibleError(400, 'bad_product', 'product is required');
  if (/^\d+$/.test(raw)) return Number(raw);
  const rows = await db`
    SELECT id FROM product_profiles
     WHERE lower(product_code) = lower(${raw}) OR lower(short_name) = lower(${raw}) OR lower(name) = lower(${raw})
     ORDER BY (lower(product_code) = lower(${raw})) DESC, id LIMIT 2`;
  if (!rows.length) throw new BibleError(404, 'product_not_found', `no product matches "${raw}"`);
  return rows[0].id;
}

const handle = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (err instanceof BibleError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
    }
    console.error('[productBible]', req.method, req.originalUrl, err);
    return res.status(500).json({ error: 'Product Bible request failed', code: 'internal' });
  }
};

router.get('/products', handle(async (req, res) => {
  res.json({ success: true, data: await listProductsWithMarkets() });
}));

router.get('/products/:product/markets', handle(async (req, res) => {
  const id = await resolveProductId(req.params.product);
  res.json({ success: true, data: await listMarkets(id) });
}));

router.get('/products/:product/markets/:market/document', handle(async (req, res) => {
  const id = await resolveProductId(req.params.product);
  res.json({ success: true, data: await getBibleDocument(id, req.params.market) });
}));

router.get('/products/:product/markets/:market/entities', handle(async (req, res) => {
  const id = await resolveProductId(req.params.product);
  const { type, avatar, angle, limit } = req.query;
  res.json({ success: true, data: await listEntities(id, req.params.market, { type, avatar, angle, limit }) });
}));

router.get('/products/:product/markets/:market/quotes', handle(async (req, res) => {
  const id = await resolveProductId(req.params.product);
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json({ success: true, data: await getQuotes(id, req.params.market, ids) });
}));

router.post('/context', handle(async (req, res) => {
  const b = req.body || {};
  const productId = await resolveProductId(b.product ?? b.productId);
  if (!b.market) throw new BibleError(400, 'bad_market', 'market is required');
  const pack = await buildBibleContextPack({
    productId, market: String(b.market), avatar: b.avatar || undefined, angle: b.angle || undefined,
    job: String(b.job || ''), query: typeof b.query === 'string' ? b.query.slice(0, 20000) : undefined, budget: b.budget,
  });
  res.json({ success: true, data: pack, jobs: Object.keys(JOB_BUDGETS) });
}));

router.post('/products/:product/markets/:market/import', sessionOnly, handle(async (req, res) => {
  const id = await resolveProductId(req.params.product);
  const b = req.body || {};
  const result = await importMarketBible({
    productId: id, marketKey: req.params.market, label: b.label, price: b.price, productUrl: b.product_url,
    sortOrder: Number(b.sort_order) || 0, markdown: b.markdown, library: b.library, quotesJsonl: b.quotes_jsonl,
    version: b.version, importedBy: req.bibleActor,
  });
  res.json({ success: true, data: result });
}));

export default router;
