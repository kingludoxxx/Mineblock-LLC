// test-timeout: 300s
// PRODUCT BIBLE — import, document, entities, context pack and API auth, proven BY EXECUTION on a fresh database.
//
//   P1  importer refuses an invalid bible (validation problems named) and writes NOTHING
//   P2  importer imports two markets of one product; a re-run with identical files is "unchanged"
//   P3  document API: toc + sections, H3 children, no <script>, quote-id chips
//   P4  context pack: operator-chosen avatar/angle are the ones used; auto-pick is flagged
//   P5  MARKET ISOLATION: a pack for market A never contains market B's avatars, angles or quotes
//   P6  every job respects its character budget; static_image is the smallest
//   P7  bad job 400, unknown avatar/angle/market 404, product without markets 404
//   P8  API auth: no credential 401, wrong service token 401, service token reads 200, service token import 403
//   P9  products without markets are absent from /products (other stores' products keep today's behaviour)
//
// Run: PB_TEST_PG=postgres://postgres@127.0.0.1:5433 node server/tests/product-bible/product-bible.mjs
import postgres from 'postgres';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PG = process.env.PB_TEST_PG || 'postgres://postgres@127.0.0.1:5433';
const DBNAME = `${process.env.BRAIN_TEST_DB_PREFIX || ''}pb_product_bible`;
const DB = `${PG}/${DBNAME}`;
const TOKEN = 'pb-test-service-token-0123456789';

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass += 1; console.log('PASS ', m); } else { fail += 1; console.log('FAIL ', m, x ? `\n      ${String(x).slice(0, 800)}` : ''); }
};

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SA' }, encoding: 'utf8', timeout: 240000,
});
ok(mig.status === 0, 'migrations (incl. 137) apply on an empty database', `${mig.stdout}\n${mig.stderr}`.slice(-1500));

process.env.DATABASE_URL = DB;
const db = postgres(DB, { ssl: false, onnotice: () => {}, max: 4 });
const { importMarketBible, getBibleDocument, listEntities, BibleError } = await import('../../src/services/productBible/bibleStore.js');
const { buildBibleContextPack, JOB_BUDGETS } = await import('../../src/services/productBible/contextPack.js');

const [{ id: productId }] = await db`INSERT INTO product_profiles (name, short_name, product_code) VALUES ('Test Device', 'TD', 'TD1') RETURNING id`;
const [{ id: plainProductId }] = await db`INSERT INTO product_profiles (name, short_name, product_code) VALUES ('Plain Product', 'PP', 'PP1') RETURNING id`;

function fixture(market, n) {
  const md = [`# Bible: ${market}`, '', 'Intro paragraph <script>alert(1)</script>.', ''];
  for (let s = 0; s < 6; s += 1) {
    md.push(`## ${s}. Section ${s} ${market}`, '', `Text about ${market} section ${s} [${market === 'alpha' ? 'Q0001' : 'Q0101'}].`, '', `### ${s}.1 Child ${market}`, '', '| a | b |', '|---|---|', `| ${market} | cell |`, '');
  }
  const avatars = [0, 1].map((i) => ({ id: `${market}_av${i}`, type: i === 0 ? 'lead' : 'sub', name: `${market} avatar ${i}`, situation: `${market} situation ${i}`, desires: { surface: [{ text: `${market} wants ${i}` }] }, best_angle_ids: [`${market}_an${i}`] }));
  const angles = [0, 1, 2].map((i) => ({ id: `${market}_an${i}`, name: `${market} angle ${i}`, tier: i === 0 ? 'A' : 'B', avatar_ids: [`${market}_av${i % 2}`], hooks: [`${market} hook ${i}`], sub_angles: [`${market} sub ${i}a`, `${market} sub ${i}b`, `${market} sub ${i}c`, `${market} sub ${i}d`] }));
  const library = {
    product: 'Test Device', funnel: market, price: '$1', launch_map: { 'Mass desire': `${market} desire` },
    mechanism: { upm_name: `${market} upm`, usm_name: `${market} usm` }, avatars, angles,
    beliefs: [{ belief: `${market} belief`, family: 'cause', move: 'reframe', quote_ids: [market === 'alpha' ? 'Q0001' : 'Q0101'] }],
    objections: [{ objection: `${market} objection`, answer: `${market} answer`, quote_ids: [] }],
    hooks: [{ hook: `${market} hook line`, avatar_id: `${market}_av0`, angle_id: `${market}_an0` }],
    competitors: [{ name: `${market} rival`, price: '$2' }], test_queue: [{ rank: 1, angle_id: `${market}_an1` }],
    banned_phrases: [`${market} banned`], tired_words: [`${market} tired`],
  };
  return { md: md.join('\n'), library, n };
}
const quotes = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: `Q${String(i + 1).padStart(4, '0')}`, funnel: 'alpha', quote: `alpha voice ${i} words about the alpha problem`, avatar: 'alpha_av0', hook_strength: 3, source: 'reddit' })),
  ...Array.from({ length: 30 }, (_, i) => ({ id: `Q${String(i + 101).padStart(4, '0')}`, funnel: 'beta', quote: `beta voice ${i} words about the beta problem`, avatar: 'beta_av0', hook_strength: 3, source: 'youtube' })),
].map((q) => JSON.stringify(q)).join('\n');

// P1
const bad = fixture('alpha');
let refused = null;
try {
  await importMarketBible({ productId, marketKey: 'alpha', label: 'Alpha', markdown: '# x\n\n## only\ntext [Q9999]', library: { avatars: [{ id: 'a', best_angle_ids: ['ghost'] }], angles: [{ id: 'b', avatar_ids: ['nobody'] }] }, quotesJsonl: quotes }, db);
} catch (e) { refused = e; }
ok(refused instanceof BibleError && refused.status === 422 && refused.details.length >= 4, 'P1 invalid bible refused with named problems', refused && JSON.stringify(refused.details));
ok((await db`SELECT count(*)::int AS n FROM product_markets`)[0].n === 0, 'P1 nothing written after refusal');
void bad;

// P2
const A = fixture('alpha'); const Bf = fixture('beta');
const r1 = await importMarketBible({ productId, marketKey: 'alpha', label: 'Alpha', price: '$1', markdown: A.md, library: A.library, quotesJsonl: quotes, version: 'T1' }, db);
const r2 = await importMarketBible({ productId, marketKey: 'beta', label: 'Beta', price: '$2', sortOrder: 1, markdown: Bf.md, library: Bf.library, quotesJsonl: quotes, version: 'T1' }, db);
ok(r1.status === 'imported' && r2.status === 'imported', 'P2 two markets imported', JSON.stringify({ r1, r2 }));
const r3 = await importMarketBible({ productId, marketKey: 'alpha', label: 'Alpha', price: '$1', markdown: A.md, library: A.library, quotesJsonl: quotes, version: 'T1' }, db);
ok(r3.status === 'unchanged', 'P2 identical re-import is unchanged', r3.status);

// P3
const doc = await getBibleDocument(productId, 'alpha', db);
ok(doc.toc.length === 7 && doc.toc[1].children.length === 1, 'P3 toc has 7 sections and H3 children', JSON.stringify(doc.toc.slice(0, 2)));
const allHtml = doc.sections.map((s) => s.html).join('');
ok(!/<script/i.test(allHtml) && /&lt;script&gt;/.test(allHtml), 'P3 raw HTML is escaped, never executable');
ok(/class="pb-qid" data-qid="Q0001"/.test(allHtml) && /<table>/.test(allHtml), 'P3 quote-id chips and tables rendered');

// P4
const pack = await buildBibleContextPack({ productId, market: 'alpha', avatar: 'alpha_av1', angle: 'alpha_an2', job: 'brief' }, db);
ok(pack.avatar.key === 'alpha_av1' && pack.angle.key === 'alpha_an2' && pack.picked.avatar === 'operator', 'P4 operator choice honoured', JSON.stringify(pack.picked));
ok(pack.text.includes('alpha sub 2a') && pack.text.includes('alpha voice'), 'P4 pack carries the angle sub-angles and verbatim quotes');
const autoPack = await buildBibleContextPack({ productId, market: 'alpha', job: 'brief' }, db);
ok(autoPack.picked.angle === 'auto' && autoPack.angle.key === 'alpha_an1', 'P4 auto-pick takes the test queue first and says so', JSON.stringify({ picked: autoPack.picked, angle: autoPack.angle }));

// P5
for (const job of Object.keys(JOB_BUDGETS)) {
  const pa = await buildBibleContextPack({ productId, market: 'alpha', job }, db);
  const pb = await buildBibleContextPack({ productId, market: 'beta', job }, db);
  ok(!/beta/i.test(pa.text) && !/alpha/i.test(pb.text), `P5 ${job}: no cross-market content`, !/beta/i.test(pa.text) ? pb.text.slice(0, 300) : pa.text.slice(0, 300));
}

// P6
const sizes = {};
for (const job of Object.keys(JOB_BUDGETS)) {
  const p = await buildBibleContextPack({ productId, market: 'alpha', job, budget: job === 'brief' ? 1500 : undefined }, db);
  sizes[job] = p.chars;
  ok(p.chars <= p.budget, `P6 ${job} within budget (${p.chars}/${p.budget})`);
}
ok(sizes.static_image <= sizes.static_copy && sizes.static_image <= sizes.funnel_page, 'P6 static_image is the smallest slice', JSON.stringify(sizes));

// P7
const code = async (fn) => { try { await fn(); return 200; } catch (e) { return e.status || 500; } };
ok(await code(() => buildBibleContextPack({ productId, market: 'alpha', job: 'nope' }, db)) === 400, 'P7 unknown job 400');
ok(await code(() => buildBibleContextPack({ productId, market: 'alpha', avatar: 'beta_av0', job: 'brief' }, db)) === 404, 'P7 other market avatar 404');
ok(await code(() => buildBibleContextPack({ productId, market: 'alpha', angle: 'ghost', job: 'brief' }, db)) === 404, 'P7 unknown angle 404');
ok(await code(() => buildBibleContextPack({ productId, market: 'gamma', job: 'brief' }, db)) === 404, 'P7 unknown market 404');
ok(await code(() => buildBibleContextPack({ productId: plainProductId, market: 'alpha', job: 'brief' }, db)) === 404, 'P7 product without markets 404');
ok((await listEntities(productId, 'beta', { type: 'angle' }, db)).every((e) => e.key.startsWith('beta_')), 'P7 entity listing is market-scoped');

// P8 + P9 over HTTP, through the real router
const host = spawn(process.execPath, ['-e', `
  const { default: express } = await import('express');
  const { default: routes } = await import(${JSON.stringify(join(REPO, 'server/src/routes/productBible.js'))});
  const app = express(); app.use(express.json({ limit: '50mb' })); app.use('/api/v1/product-bible', routes);
  const s = app.listen(0, () => console.log('LISTENING ' + s.address().port));
`], { env: { ...process.env, DATABASE_URL: DB, BRAIN_SERVICE_TOKEN: TOKEN, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
host.stderr.on('data', (d) => { stderr += d; });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`host did not start: ${stderr.slice(-800)}`)), 30000);
  host.stdout.on('data', (d) => { const m = /LISTENING (\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
});
const base = `http://127.0.0.1:${port}/api/v1/product-bible`;
const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const svc = { 'x-brain-service-token': TOKEN };

ok((await get('/products')).status === 401, 'P8 no credential -> 401');
ok((await get('/products', { 'x-brain-service-token': 'wrong-token-wrong-token-0000' })).status === 401, 'P8 wrong service token -> 401');
const prodRes = await get('/products', svc);
const prodBody = await prodRes.json();
ok(prodRes.status === 200 && prodBody.data.length === 1 && prodBody.data[0].markets.length === 2, 'P8 service token lists products with markets', JSON.stringify(prodBody).slice(0, 400));
ok(!prodBody.data.some((p) => p.id === plainProductId), 'P9 product without markets is not listed');
ok((await get('/products/TD1/markets/beta/document', svc)).status === 200, 'P8 document by product CODE via service token -> 200');
const ctx = await post('/context', { product: 'TD1', market: 'beta', job: 'static_copy' }, svc);
const ctxBody = await ctx.json();
ok(ctx.status === 200 && ctxBody.data.market.key === 'beta' && !/alpha/.test(ctxBody.data.text), 'P8 context over HTTP, market-scoped', JSON.stringify(ctxBody).slice(0, 300));
ok((await post('/context', { product: 'TD1', market: 'beta', job: 'bogus' }, svc)).status === 400, 'P8 context bad job -> 400');
ok((await post('/products/TD1/markets/alpha/import', { label: 'x' }, svc)).status === 403, 'P8 service token cannot import -> 403');
const quotesRes = await get('/products/TD1/markets/alpha/quotes?ids=Q0001,Q0101', svc);
const quotesBody = await quotesRes.json();
ok(quotesRes.status === 200 && quotesBody.data.length === 1 && quotesBody.data[0].quote_id === 'Q0001', 'P8 quotes are market-scoped (other market id not returned)', JSON.stringify(quotesBody));

host.kill('SIGTERM');
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
