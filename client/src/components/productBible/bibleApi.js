// PRODUCT BIBLE — client data layer for /api/v1/product-bible (server/src/routes/productBible.js).
// Every read goes through the shared axios instance (one auth path). Results are cached per page load; a failed
// request is NOT cached, so the next caller retries instead of inheriting the failure.
import api from '../../services/api';

const cache = new Map();
const settled = new Map(); // key -> resolved value, readable synchronously

function cached(key, load) {
  if (cache.has(key)) return cache.get(key);
  const p = load().then((value) => {
    settled.set(key, value);
    return value;
  }, (err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  return p;
}

const enc = encodeURIComponent;
const unwrap = (res) => {
  const d = res?.data?.data;
  if (d === undefined) throw new Error('Unexpected Product Bible response');
  return d;
};

/** Products that have at least one market. [] when the store has none. */
export function fetchBibleProducts() {
  return cached('products', async () => {
    const d = unwrap(await api.get('/product-bible/products'));
    return Array.isArray(d) ? d : [];
  });
}

export function fetchBibleMarkets(product) {
  return cached(`markets:${product}`, async () => {
    const d = unwrap(await api.get(`/product-bible/products/${enc(product)}/markets`));
    return Array.isArray(d) ? d : [];
  });
}

export function fetchBibleDocument(product, market) {
  return cached(`doc:${product}:${market}`, async () =>
    unwrap(await api.get(`/product-bible/products/${enc(product)}/markets/${enc(market)}/document`)));
}

/** Entities already loaded for this page, without waiting; undefined when not loaded yet. */
export function peekBibleEntities(product, market, type) {
  return settled.get(`ents:${product}:${market}:${type}`);
}

export function fetchBibleEntities(product, market, type) {
  return cached(`ents:${product}:${market}:${type}`, async () => {
    const d = unwrap(await api.get(`/product-bible/products/${enc(product)}/markets/${enc(market)}/entities`, {
      params: { type, limit: 2000 },
    }));
    return Array.isArray(d) ? d : [];
  });
}

const quoteCache = new Map(); // `${product}:${market}:${id}` -> quote row | null (null = asked, not found)

/** Resolve quote ids; only ids not yet asked for hit the network. Returns a Map id -> quote|null. */
export async function fetchBibleQuotes(product, market, ids) {
  const want = [...new Set((ids || []).filter((id) => /^Q\d{4,5}$/.test(id)))];
  const missing = want.filter((id) => !quoteCache.has(`${product}:${market}:${id}`));
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200);
    const rows = unwrap(await api.get(`/product-bible/products/${enc(product)}/markets/${enc(market)}/quotes`, {
      params: { ids: batch.join(',') },
    }));
    const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.quote_id, r]));
    for (const id of batch) quoteCache.set(`${product}:${market}:${id}`, byId.get(id) || null);
  }
  return new Map(want.map((id) => [id, quoteCache.get(`${product}:${market}:${id}`) ?? null]));
}

/** Readable error text from an axios error or plain Error. */
export function bibleErrorText(err) {
  const e = err?.response?.data?.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return err?.message || 'Request failed';
}

/** Test hook: drop every cached response. */
export function clearBibleCache() {
  cache.clear();
  quoteCache.clear();
}
