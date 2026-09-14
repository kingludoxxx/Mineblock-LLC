#!/usr/bin/env node
// Import one market's Product Bible into THIS store's database (the DATABASE_URL in the environment).
//
//   node server/scripts/product-bible-import.mjs --product <id|code> --market <key> --label "<Label>"
//        --md <bible.md> --json <library.json> --quotes <quotes.jsonl>
//        [--price "$99"] [--url https://...] [--sort 0] [--version V2] [--dry-run]
//
// Fails loudly: every validation problem is printed and the exit code is 1; nothing is written on failure.
// Re-running with identical files reports "unchanged" and writes nothing.
import { readFileSync, existsSync } from 'node:fs';
import postgres from 'postgres';
import { importMarketBible, BibleError } from '../src/services/productBible/bibleStore.js';
import { parseBibleMarkdown, buildEntities, selectQuotes, citedQuoteIds, validateBible } from '../src/services/productBible/bibleParse.js';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'dry-run') { out.dryRun = true; continue; }
    out[k] = argv[i + 1];
    i += 1;
  }
  return out;
}

const a = args(process.argv.slice(2));
const need = ['product', 'market', 'label', 'md', 'json', 'quotes'];
const missing = need.filter((k) => !a[k]);
if (missing.length) {
  console.error(`ERROR: missing --${missing.join(', --')}`);
  process.exit(1);
}
for (const k of ['md', 'json', 'quotes']) {
  if (!existsSync(a[k])) { console.error(`ERROR: --${k} file not found: ${a[k]}`); process.exit(1); }
}
const markdown = readFileSync(a.md, 'utf8');
const libraryText = readFileSync(a.json, 'utf8');
const quotesJsonl = readFileSync(a.quotes, 'utf8');
let library;
try { library = JSON.parse(libraryText); } catch (e) { console.error(`ERROR: --json does not parse: ${e.message}`); process.exit(1); }

if (a.dryRun) {
  const { sections } = parseBibleMarkdown(markdown);
  const entities = buildEntities(library);
  const quotes = selectQuotes(quotesJsonl, a.market);
  const all = new Set(quotesJsonl.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).id));
  const problems = validateBible({ sections, entities, quotes, citedIds: citedQuoteIds(markdown, entities), allQuoteIds: all });
  console.log(JSON.stringify({ dryRun: true, sections: sections.filter((s) => s.level === 2).length, entities: entities.length, quotes: quotes.length, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('ERROR: DATABASE_URL is not set'); process.exit(1); }
const local = /localhost|127\.0\.0\.1|host=\/|@\/|sslmode=disable/.test(url);
const db = postgres(url, { ssl: local ? false : 'require', max: 2, onnotice: () => {}, connection: { statement_timeout: 120000 } });
try {
  let productId = a.product;
  if (!/^\d+$/.test(String(productId))) {
    const rows = await db`SELECT id FROM product_profiles WHERE lower(product_code) = lower(${productId}) OR lower(short_name) = lower(${productId}) ORDER BY id LIMIT 1`;
    if (!rows.length) throw new BibleError(404, 'product_not_found', `no product with code "${productId}"`);
    productId = rows[0].id;
  }
  const result = await importMarketBible({
    productId, marketKey: a.market, label: a.label, price: a.price, productUrl: a.url, sortOrder: Number(a.sort) || 0,
    markdown, library, quotesJsonl, version: a.version, importedBy: 'cli',
  }, db);
  console.log(JSON.stringify({ ok: true, productId: Number(productId), market: a.market, ...result }, null, 2));
  await db.end();
  process.exit(0);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  if (err.details) for (const d of err.details) console.error(`  - ${d}`);
  await db.end().catch(() => {});
  process.exit(1);
}
