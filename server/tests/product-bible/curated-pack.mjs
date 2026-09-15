// test-timeout: 300s
// PRODUCT PACK: an operator-approved pack (product core + pinned angles) replaces the bible slice for its market.
//   C1  without a pack the bible is read exactly as before (entities, pack text)
//   C2  with a pack: auto statics copy lists every pinned angle + the core, and nothing from the bible
//   C3  a chosen pinned angle: its full brief, customer voice and bans; no other angle
//   C4  an unknown or research-bible angle key -> 404; a stored research selection falls back instead of failing
//   C5  detection catalog and angle definitions come from the pack
//   C6  statics analysis prompt: pack + COPY APPROACH, no legacy angle block, unit_details not used; image prompt carries the core
//   C7  brief context is the pack; the other market (no pack) still reads its bible
//   C8  the entities API offers only the pinned angles and no avatars; ?source=bible still returns the research
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PG = process.env.PB_TEST_PG || 'postgres://postgres@127.0.0.1:5433';
const DBNAME = `${process.env.BRAIN_TEST_DB_PREFIX || ''}pb_curated_pack`;
const DB = `${PG}/${DBNAME}`;
const FX = JSON.parse(readFileSync(join(HERE, 'pipeline-bible.fixtures.json'), 'utf8'));
const BASE = JSON.parse(readFileSync(join(HERE, 'pipeline-bible.baseline.json'), 'utf8'));

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass += 1; console.log('PASS ', m); } else { fail += 1; console.log('FAIL ', m, x ? `\n      ${String(x).slice(0, 900)}` : ''); }
};
const code = async (fn) => { try { await fn(); return 200; } catch (e) { return e.status || `threw: ${e.message}`; } };

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();

const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SA' }, encoding: 'utf8', timeout: 240000,
});
ok(mig.status === 0, 'B1 migrations apply on an empty database', `${mig.stdout}\n${mig.stderr}`.slice(-1500));

process.env.DATABASE_URL = DB;
const db = postgres(DB, { ssl: false, onnotice: () => {}, max: 4 });

const cols = await db`SELECT table_name FROM information_schema.columns WHERE column_name = 'bible' AND data_type = 'jsonb'
  AND table_name IN ('brief_pipeline_generated', 'brief_generation_jobs', 'spy_creatives', 'statics_queue')`;
ok(cols.length === 4, 'B1 bible JSONB column on briefs, brief jobs, statics creatives and statics queue', JSON.stringify(cols));

const { importMarketBible, BibleError } = await import('../../src/services/productBible/bibleStore.js');
const pb = await import('../../src/services/productBible/pipelineBible.js');
const { buildProductContextForBrief, buildBriefProductContext } = await import('../../src/utils/briefProductContext.js');
const sp = await import('../../src/utils/staticsPrompts.js');
const { buildCopyPrompt } = await import('../../src/services/staticsCopywriter.js');

const [bibleRow] = await db`INSERT INTO product_profiles (name, short_name, product_code, price, big_promise, master_brief)
  VALUES ('Test Device', 'TDV', 'TD1', '$5', 'Legacy device promise', 'LEGACY MASTER BRIEF') RETURNING *`;
const [plainDbRow] = await db`INSERT INTO product_profiles (name, short_name, product_code) VALUES ('Plain Product', 'PP', 'PP1') RETURNING *`;

function fixture(market) {
  const md = [`# Bible: ${market}`, ''];
  for (let s = 0; s < 6; s += 1) md.push(`## ${s}. Section ${s} ${market}`, '', `Text ${market} ${s} [${market === 'alpha' ? 'Q0001' : 'Q0101'}].`, '');
  const avatars = [0, 1].map((i) => ({ id: `${market}_av${i}`, type: i === 0 ? 'lead' : 'sub', name: `${market} avatar ${i}`, situation: `${market} situation ${i}`, best_angle_ids: [`${market}_an${i}`] }));
  const angles = [0, 1, 2].map((i) => ({
    id: `${market}_an${i}`, name: `${market} angle ${i}`, tier: i === 0 ? 'A' : 'B', avatar_ids: [`${market}_av${i % 2}`],
    tone: `${market} tone ${i}`, lead_with: `${market} lead ${i}`, hooks: [`${market} hook ${i}`],
    headline_examples: [`${market} headline ${i}a`, `${market} headline ${i}b`],
    sub_angles: [`${market} sub ${i}a [Q0001]`, `${market} sub ${i}b`], banned_phrases: [`${market} angle banned ${i}`],
  }));
  return {
    md: md.join('\n'),
    library: {
      product: 'Test Device', funnel: market, avatars, angles, mechanism: { upm_name: `${market} upm` },
      hooks: [{ hook: `${market} hook line`, avatar_id: `${market}_av0`, angle_id: `${market}_an0` }],
      objections: [{ objection: `${market} objection`, answer: `${market} answer`, quote_ids: [] }],
      test_queue: [{ rank: 1, angle_id: `${market}_an1` }], banned_phrases: [`${market} banned`],
    },
  };
}
const quotes = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `Q${String(i + 1).padStart(4, '0')}`, funnel: 'alpha', quote: `alpha voice ${i} about the alpha problem`, avatar: 'alpha_av0', hook_strength: 3 })),
  ...Array.from({ length: 12 }, (_, i) => ({ id: `Q${String(i + 101).padStart(4, '0')}`, funnel: 'beta', quote: `beta voice ${i} about the beta problem`, avatar: 'beta_av0', hook_strength: 3 })),
].map((q) => JSON.stringify(q)).join('\n');
const A = fixture('alpha'); const Bf = fixture('beta');
await importMarketBible({ productId: bibleRow.id, marketKey: 'alpha', label: 'Alpha Pain', price: '$1', productUrl: 'https://example.test/a', sortOrder: 0, markdown: A.md, library: A.library, quotesJsonl: quotes }, db);
await importMarketBible({ productId: bibleRow.id, marketKey: 'beta', label: 'Beta Relief', price: '$2', productUrl: 'https://example.test/b', sortOrder: 1, markdown: Bf.md, library: Bf.library, quotesJsonl: quotes }, db);


const { loadCuratedMarket, curatedFromRow, AUTO_ANGLE_KEY } = await import('../../src/services/productBible/curatedPack.js');
const { listEntities } = await import('../../src/services/productBible/bibleStore.js');

// ── C1 ──
const before = await pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta' }, productRow: bibleRow, job: 'static_copy' }, db);
ok(before.text.includes('PRODUCT BIBLE CONTEXT') && !before.curated, 'C1 no pack: the bible pack as before');
ok((await pb.bibleCatalog(bibleRow.id, 'beta', db)).angles.length === 3, 'C1 no pack: catalog = the 3 bible angles');

// The operator approves a pack for beta only.
await db.unsafe(`ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS market_packs JSONB DEFAULT '{}'`);
const PINNED = [
  { id: 'pin_one', name: 'Pinned One', market: 'beta', funnel_stage: 'top', avatar: 'Pinned one avatar. Second sentence.', hook_strategy: 'pinned one hook strategy',
    lead_with: 'pinned one lead', tone: 'pinned one tone', copy_directives: '- pinned one directive', required_elements: ['pinned one element'],
    headline_examples: ['Pinned one headline A', 'Pinned one headline B', 'Pinned one headline C', 'Pinned one headline D'],
    customer_voice: ['pinned one voice'], banned_phrases: ['pinned one banned'] },
  { id: 'pin_two', name: 'Pinned Two', market: 'beta', hook_strategy: 'pinned two hook strategy', lead_with: 'pinned two lead',
    headline_examples: ['Pinned two headline A'], customer_voice: ['pinned two voice'], banned_phrases: ['pinned two banned'] },
  { id: 'pin_alpha', name: 'Alpha Pinned', market: 'alpha', hook_strategy: 'alpha pinned' },
];
await db`UPDATE product_profiles SET angles = ${db.json(PINNED)}, market_packs = ${db.json({ beta: { core: 'BETA PRODUCT CORE: looks like a small silver oval.' } })}, unit_details = 'LEGACY UNIT DETAILS SALES COPY' WHERE id = ${bibleRow.id}`;
const [freshRow] = await db`SELECT * FROM product_profiles WHERE id = ${bibleRow.id}`;
ok(curatedFromRow(freshRow, 'alpha') === null, 'C1 a market with pinned angles but no core has no pack');
ok((await loadCuratedMarket(bibleRow.id, 'beta', db))?.angles.length === 2, 'C1 beta pack = core + its 2 pinned angles (alpha angle excluded)');

// ── C2 ──
const auto = await pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta' }, productRow: bibleRow, job: 'static_copy' }, db);
ok(auto.curated && auto.angle.key === AUTO_ANGLE_KEY && auto.picked.angle === 'auto', 'C2 auto: curated pack, angle auto', JSON.stringify({ a: auto.angle, p: auto.picked }));
ok(auto.text.includes('BETA PRODUCT CORE') && auto.text.includes('Pinned One') && auto.text.includes('Pinned Two') && auto.text.includes('CHOOSE THE ANGLE') && auto.text.includes('chosen_angle'),
  'C2 auto pack: core + every pinned angle + the choose instruction', auto.text.slice(0, 900));
ok(!/beta angle \d|beta avatar|beta voice|beta hook|Alpha Pinned/.test(auto.text), 'C2 nothing from the research bible and nothing from another market', auto.text);
ok(!auto.text.includes('Pinned one headline D') && !auto.text.includes('pinned one banned'), 'C2 statics auto lists compact briefs (3 headlines, no ban list per angle)');

// ── C3 ──
const chosen = await pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta', angle: 'pin_one', avatar: 'beta_av0' }, productRow: bibleRow, job: 'static_copy' }, db);
ok(chosen.angle.key === 'pin_one' && chosen.picked.angle === 'operator' && chosen.avatar.title === 'Pinned one avatar.', 'C3 chosen angle honoured; avatar comes from the angle', JSON.stringify({ a: chosen.angle, av: chosen.avatar }));
ok(chosen.text.includes('Pinned one headline D') && chosen.text.includes('pinned one voice') && chosen.text.includes('pinned one banned') && chosen.text.includes('- pinned one directive')
  && !chosen.text.includes('Pinned Two') && !chosen.text.includes('CHOOSE THE ANGLE'), 'C3 full brief of the chosen angle only', chosen.text);

// ── C4 ──
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta', angle: 'beta_an0' }, productRow: bibleRow, job: 'brief' }, db)) === 404, 'C4 a research-bible angle key is not a pinned angle -> 404');
const rec = await pb.resolveRecordBible({ productRow: bibleRow, loadPersisted: async () => ({ market: 'beta', avatar: 'beta_av0', angle: 'beta_an1' }), job: 'static_copy' }, db);
ok(rec?.curated && rec.market.key === 'beta', 'C4 a stored research selection no longer resolves and falls back to the pack instead of failing', JSON.stringify(rec && { m: rec.market, a: rec.angle }));

// ── C5 ──
const cat = await pb.bibleCatalog(bibleRow.id, 'beta', db);
ok(cat.avatars.length === 0 && cat.angles.map((a) => a.key).join(',') === 'pin_one,pin_two', 'C5 catalog = pinned angles, no avatars', JSON.stringify(cat));
const defAuto = await pb.bibleAngleDef(bibleRow.id, 'beta', AUTO_ANGLE_KEY, '', db);
const defOne = await pb.bibleAngleDef(bibleRow.id, 'beta', 'pin_one', '', db);
ok(defAuto.name === 'AUTO' && defOne.name === 'Pinned One' && defOne.headline_examples.length === 4 && defOne.copy_directives === '- pinned one directive', 'C5 angle definitions from the pack', JSON.stringify({ defAuto, defOne }));
const parts = pb.bibleCloneAngleParts(defOne, cat);
ok(parts.anglesList.includes('Pinned One') && parts.anglesList.includes('Pinned Two') && parts.angleName === 'Pinned One', 'C5 brief clone angle parts list only pinned angles');

// ── C6 ──
const sb = await pb.resolveStaticsBible({ bible: { product: 'TD1', market: 'beta', angle: null }, productRow: bibleRow }, db);
const statProduct = { id: freshRow.id, name: freshRow.name, price: freshRow.price, profile: sp.mapProductRowToFlatProfile(freshRow), _bible: sb };
const tpl = 'Product: {{PRODUCT_NAME}}\nUnit Details: {{UNIT_DETAILS}}\nAngle: {{ANGLE}}\nTEXT RULES: this is a SWAP, not a rewrite.';
const analysis = sp.buildClaudeAnalysisPrompt(statProduct, '', tpl, {});
ok(analysis.includes('BETA PRODUCT CORE') && analysis.includes('COPY APPROACH') && analysis.includes('Pinned Two'), 'C6 analysis prompt: pack + copy approach', analysis.slice(0, 1500));
ok(!analysis.includes('LEGACY UNIT DETAILS SALES COPY') && !analysis.includes('MARKETING ANGLES — PRODUCT LIBRARY') && !/beta angle \d/.test(analysis), 'C6 no unit_details sales copy, no legacy angle block, no bible angles', analysis);
const img = sp.buildNanoBananaImagePrompt(FX.claudeResult, { ...statProduct, _angle: '' }, FX.imageTemplate, {}, { maxChars: 29000, referenceCount: 2 });
ok(img.includes('BETA PRODUCT CORE') && img.includes('NEW HEADLINE'), 'C6 image prompt carries the product core and the copy', img.slice(-900));

// ── C7 ──
ok(buildBriefProductContext(freshRow, chosen) === chosen.text, 'C7 brief product context is the pack text');
const alphaStill = await pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'alpha' }, productRow: bibleRow, job: 'brief' }, db);
ok(!alphaStill.curated && alphaStill.text.includes('PRODUCT BIBLE CONTEXT') && alphaStill.text.includes('alpha'), 'C7 alpha (no core) still reads its bible');

// ── C8 ──
process.env.BRAIN_SERVICE_TOKEN = 'curated-pack-test-token-0123456789';
const express = (await import('express')).default;
const router = (await import('../../src/routes/productBible.js')).default;
const { SERVICE_TOKEN_HEADER } = await import('../../src/middleware/brainAuth.js');
const app = express();
app.use('/pb', router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/pb`;
const get = async (p) => { const r = await fetch(base + p, { headers: { [SERVICE_TOKEN_HEADER]: process.env.BRAIN_SERVICE_TOKEN } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const angEnt = await get(`/products/${bibleRow.id}/markets/beta/entities?type=angle`);
const avEnt = await get(`/products/${bibleRow.id}/markets/beta/entities?type=avatar`);
const research = await get(`/products/${bibleRow.id}/markets/beta/entities?type=angle&source=bible`);
ok(angEnt.status === 200 && angEnt.body?.data?.map((a) => a.title).join('|') === 'Pinned One|Pinned Two' && angEnt.body.data.every((a) => a.tier === null), 'C8 entities API: only pinned angles, no tiers', JSON.stringify(angEnt).slice(0, 400));
ok(avEnt.status === 200 && Array.isArray(avEnt.body?.data) && avEnt.body.data.length === 0, 'C8 entities API: no avatars with a pack', JSON.stringify(avEnt).slice(0, 300));
ok(research.status === 200 && research.body?.data?.length === 3, 'C8 ?source=bible still returns the research angles', JSON.stringify(research).slice(0, 300));
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
await db.end();
process.exit(fail ? 1 : 0);
