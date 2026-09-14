// test-timeout: 300s
// PRODUCT BIBLE -> CONTENT PIPELINES, proven BY EXECUTION on a fresh database.
//
//   B1  migrations apply; the `bible` selection column exists on every record a pipeline writes
//   B2  resolver: a product WITHOUT markets returns null (callers keep today's behaviour), never throws
//   B3  resolver: infers the market from hint text (card name / avatar field); ambiguous or no match -> first, 'auto'
//   B4  resolver: an explicit invalid selection is a clear 404 (angle, market, product without markets)
//   B5  brief product context: the pack text (with avatar/angle keys) when markets exist, the legacy text otherwise
//   B6  statics: analysis, image and copy prompts carry their own pack; the image prompt stays under its budget;
//       the bible angle replaces the legacy angle block
//   B7  no markets: every statics/brief builder output is byte-identical to the pre-change baseline
//   B8  avatar/angle detection catalog comes from the market's bible entities
//   B9  assistants: a conversation naming a product with markets gets the chat pack; others get nothing
//
// Run: PB_TEST_PG=postgres://postgres@127.0.0.1:5433 node server/tests/product-bible/pipeline-bible.mjs
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PG = process.env.PB_TEST_PG || 'postgres://postgres@127.0.0.1:5433';
const DBNAME = `${process.env.BRAIN_TEST_DB_PREFIX || ''}pb_pipeline_bible`;
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

// ── B2 ──
ok(await pb.resolvePipelineBible({ productRow: plainDbRow, hintText: 'Beta Relief', job: 'brief' }, db) === null, 'B2 product without markets -> null');
ok(await pb.resolvePipelineBible({ productRow: null, hintText: 'Beta Relief', job: 'brief' }, db) === null, 'B2 no product row -> null');

// ── B3 ──
const card = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: 'TD1 - B0012 - IT - B0012 - Beta Relief - Mashup - WK12', job: 'brief' }, db);
ok(card?.market.key === 'beta' && card.marketPicked === 'inferred' && card.picked.market === 'inferred', 'B3 card name "... Beta Relief ..." -> beta, inferred', JSON.stringify(card && { m: card.market, p: card.picked }));
const card2 = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: 'TD1 - B0013 - NN - Alpha Pain - UGC', job: 'brief' }, db);
ok(card2?.market.key === 'alpha' && card2.marketPicked === 'inferred', 'B3 card name "... Alpha Pain ..." -> alpha', JSON.stringify(card2 && card2.market));
const avField = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: ['', 'Beta Relief'], job: 'brief' }, db);
ok(avField?.market.key === 'beta', 'B3 avatar field "Beta Relief" (hint list) -> beta', JSON.stringify(avField && avField.market));
const word = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: 'fast relief for tired people', job: 'brief' }, db);
ok(word?.market.key === 'beta' && word.marketPicked === 'inferred', 'B3 a single distinctive label word ("relief") -> beta', JSON.stringify(word && word.market));
const amb = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: 'Alpha Pain versus Beta Relief', job: 'brief' }, db);
ok(amb?.market.key === 'alpha' && amb.marketPicked === 'auto', 'B3 ambiguous -> first market by sort_order, auto', JSON.stringify(amb && { m: amb.market, p: amb.marketPicked }));
const none = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: 'nothing relevant here', job: 'brief' }, db);
ok(none?.market.key === 'alpha' && none.marketPicked === 'auto' && none.markets.length === 2, 'B3 no match -> first market, auto, markets listed', JSON.stringify(none && { m: none.market, p: none.marketPicked, ms: none.markets }));
const priority = await pb.resolvePipelineBible({ productRow: bibleRow, hintText: ['Beta Relief card', 'transcript mentions alpha pain and beta relief'], job: 'brief' }, db);
ok(priority?.market.key === 'beta' && priority.marketPicked === 'inferred', 'B3 hints are tried in priority order: a decisive first hint wins over an ambiguous transcript');

// ── B4 ──
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta', angle: 'ghost' }, productRow: bibleRow, job: 'brief' }, db)) === 404, 'B4 explicit unknown angle -> 404');
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta', angle: 'alpha_an0' }, productRow: bibleRow, job: 'brief' }, db)) === 404, 'B4 explicit angle of ANOTHER market -> 404');
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'gamma' }, productRow: bibleRow, job: 'brief' }, db)) === 404, 'B4 explicit unknown market -> 404');
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'PP1', market: 'beta' }, productRow: plainDbRow, job: 'brief' }, db)) === 404, 'B4 explicit bible on a product without markets -> 404');
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'nope-nope', market: 'beta' }, job: 'brief' }, db)) === 404, 'B4 explicit unknown product -> 404');
ok(await code(() => pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta' }, productRow: bibleRow, job: 'nope' }, db)) === 400, 'B4 bad job -> 400');
const explicit = await pb.resolvePipelineBible({ bible: { product: String(bibleRow.id), market: 'beta', avatar: 'beta_av1', angle: 'beta_an2' }, job: 'brief' }, db);
ok(explicit.market.key === 'beta' && explicit.avatar.key === 'beta_av1' && explicit.angle.key === 'beta_an2'
  && explicit.picked.market === 'operator' && explicit.picked.avatar === 'operator', 'B4 explicit valid selection honoured, picked=operator', JSON.stringify(explicit.picked));
const nullKeys = await pb.resolvePipelineBible({ bible: { product: 'TD1', market: 'beta', avatar: null, angle: null }, productRow: bibleRow, job: 'brief' }, db);
ok(nullKeys.picked.avatar === 'auto' && nullKeys.picked.angle === 'auto' && nullKeys.picked.market === 'operator', 'B4 avatar/angle null = auto');
const selMarketNull = await pb.resolvePipelineBible({ bible: { product: 'TD1', market: null }, productRow: bibleRow, hintText: 'Beta Relief', job: 'brief' }, db);
ok(selMarketNull.market.key === 'beta' && selMarketNull.marketPicked === 'inferred', 'B4 explicit bible with market null infers the market from hints');

// ── B5 ──
const briefCtx = buildBriefProductContext(bibleRow, explicit);
ok(briefCtx === explicit.text && briefCtx.includes('[beta_av1]') && briefCtx.includes('[beta_an2]'), 'B5 brief context is the pack text with avatar + angle keys');
ok(!briefCtx.includes('LEGACY MASTER BRIEF') && !briefCtx.includes('Legacy device promise'), 'B5 legacy fields and master brief are NOT sent alongside the pack');
ok(buildBriefProductContext(FX.plainRow, null) === BASE.briefContext, 'B5/B7 no pack -> legacy brief context byte-identical to baseline', buildBriefProductContext(FX.plainRow, null));
ok(buildProductContextForBrief(null) === BASE.briefContextNull, 'B7 legacy "no profile" text unchanged');

// ── B6 ──
const sb = await pb.resolveStaticsBible({ bible: { product: 'TD1', market: 'beta', avatar: 'beta_av0', angle: 'beta_an0' }, productRow: bibleRow }, db);
ok(sb.copy.job === 'static_copy' && sb.image.job === 'static_image' && sb.copy.angle.key === 'beta_an0' && sb.image.angle.key === 'beta_an0'
  && sb.image.avatar.key === 'beta_av0', 'B6 statics resolution builds static_copy + static_image packs for ONE selection', JSON.stringify({ c: sb.copy.angle, i: sb.image.angle }));
ok(sb.angleDef.name === 'beta angle 0' && sb.angleDef.headline_examples.includes('beta headline 0a') && sb.angleDef.headline_examples.includes('beta hook 0')
  && sb.angleDef.required_elements.includes('beta sub 0a') && sb.angleDef.banned_phrases.includes('beta angle banned 0') && sb.angleDef.banned_phrases.includes('beta banned'),
'B6 bible angle mapped to the angle-block shape (hooks+headlines, sub-angles without quote ids, angle+market banned phrases)', JSON.stringify(sb.angleDef));
ok(JSON.stringify(sb.selection) === JSON.stringify({ product_id: bibleRow.id, market: 'beta', avatar: 'beta_av0', angle: 'beta_an0', picked: { market: 'operator', avatar: 'operator', angle: 'operator' } }),
  'B6 selection record to persist', JSON.stringify(sb.selection));

const bibleProduct = { id: bibleRow.id, name: bibleRow.name, price: bibleRow.price, description: 'legacy description', profile: sp.mapProductRowToFlatProfile(bibleRow), _bible: sb };
const analysis = sp.buildClaudeAnalysisPrompt(bibleProduct, 'Legacy Angle', FX.analysisTemplate, { PRODUCT_IMAGE_NOTE: '\nIMAGE NOTE' });
ok(analysis.includes(sb.copy.text), 'B6 analysis prompt carries the static_copy pack');
ok(!analysis.includes('LEGACY MASTER BRIEF') && !analysis.includes('Legacy device promise') && !analysis.includes('Legacy Angle'), 'B6 analysis prompt drops MASTER_BRIEF, legacy fields and the legacy angle', analysis.slice(0, 900));
ok(analysis.includes('SELECTED ANGLE: beta angle 0') && analysis.includes('beta headline 0b') && analysis.includes('Angle: beta angle 0') && analysis.includes('at $2'),
  'B6 analysis prompt: bible angle block, bible angle name and the MARKET price', analysis.slice(0, 600));
ok(!/alpha/i.test(analysis), 'B6 analysis prompt has no other-market content');

for (const [label, max] of [['nanobanana', 2000], ['openai', 29000]]) {
  const img = sp.buildNanoBananaImagePrompt(FX.claudeResult, { ...bibleProduct, _angle: 'Legacy Angle' }, FX.imageTemplate, {}, { maxChars: max });
  ok(img.length <= max, `B6 image prompt within budget (${label}: ${img.length}/${max})`);
  ok(img.includes('NEW HEADLINE') && img.includes('PRODUCT BIBLE CONTEXT') && img.includes('Final rule: render every text swap exactly.'),
    `B6 image prompt (${label}) keeps the copy swaps + template and carries the static_image pack`, img.slice(-1200));
  ok(!img.includes('Legacy device promise') && !/alpha/i.test(img), `B6 image prompt (${label}) drops legacy marketing fields, no other market`);
  if (max > 20000) ok(img.includes(sb.image.text), 'B6 image prompt with room carries the WHOLE static_image pack');
}
const imgJson = sp.buildNanoBananaImagePrompt(FX.claudeResult, { ...bibleProduct, _angle: 'x' }, FX.imageTemplateJson, {}, { maxChars: 29000 });
ok(imgJson.includes(sb.image.text) && imgJson.length <= 29000, 'B6 JSON-shaped image template: pack appended verbatim (not JSON-escaped)');

const copy = buildCopyPrompt({ product: bibleRow, angle: sb.angleDef, format: 'statement', hook: 'beta headline 0a', proof: 'beta sub 0a', count: 3, bible: sb.copy });
ok(copy.includes(sb.copy.text) && copy.includes('ANGLE: beta angle 0') && copy.includes('"beta angle banned 0"'), 'B6 copy prompt carries the static_copy pack and the bible angle');
ok(!copy.includes('Legacy device promise'), 'B6 copy prompt drops the legacy promise line');
const variant = sp.renderAngleVariantBlock([sb.angleDef], sb.angleDef.name, 1);
ok(/beta headline 0|beta hook 0/.test(variant) && variant.includes('beta sub 0'), 'B6 angle VARIANT block rotates the bible angle hooks / sub-angles', variant);

// ── B7 ──
const plain = FX.plainRow;
const plainProduct = { id: plain.id, name: plain.name, price: plain.price, description: plain.description, profile: sp.mapProductRowToFlatProfile(plain) };
ok(await pb.resolveStaticsBible({ productRow: plainDbRow, hintText: 'Beta Relief' }, db) === null, 'B7 statics resolution for a product without markets -> null');
ok(sp.buildClaudeAnalysisPrompt(plainProduct, 'Legacy Angle', FX.analysisTemplate, { PRODUCT_IMAGE_NOTE: '\nIMAGE NOTE' }) === BASE.analysis, 'B7 analysis prompt byte-identical to baseline');
ok(sp.buildNanoBananaImagePrompt(FX.claudeResult, { ...plainProduct, _angle: 'Legacy Angle' }, FX.imageTemplate, {}, { maxChars: 2000 }) === BASE.image2000, 'B7 image prompt byte-identical to baseline');
ok(sp.buildNanoBananaImagePrompt(FX.claudeResult, { ...plainProduct, _angle: 'Legacy Angle' }, FX.imageTemplateJson, {}, { maxChars: 29000 }) === BASE.imageJson, 'B7 JSON image prompt byte-identical to baseline');
ok(sp.renderAngleVariantBlock(plain.angles, 'Legacy Angle', 1) === BASE.angleVariant, 'B7 angle variant block byte-identical to baseline');
ok(buildCopyPrompt({ product: plain, angle: plain.angles[0], ...FX.copyArgs }) === BASE.copy, 'B7 copy prompt byte-identical to baseline');

// ── B8 ──
const cat = await pb.bibleCatalog(bibleRow.id, 'beta', db);
ok(cat.avatars.length === 2 && cat.angles.length === 3 && cat.avatars.every((a) => a.key.startsWith('beta_') && a.name) && cat.angles[0].name === 'beta angle 0',
  'B8 detection catalog = this market\'s bible avatars + angles (names = titles, keys kept)', JSON.stringify(cat).slice(0, 400));
ok(pb.catalogKey(cat.angles, 'beta angle 2') === 'beta_an2' && pb.catalogKey(cat.angles, 'invented') === null, 'B8 detected names map back to entity keys; hallucinated names rejected');

// ── B9 ──
const chat = await pb.resolveChatBible({ text: 'Write three hooks for the TD1 for people who want relief', query: 'hooks' }, db);
ok(chat?.pack.job === 'chat' && chat.pack.market.key === 'beta' && chat.block.includes(chat.pack.text) && !chat.note, 'B9 conversation naming a product code with markets -> chat pack, market inferred', JSON.stringify(chat && { m: chat.pack.market, note: chat.note }));
const chatAmb = await pb.resolveChatBible({ text: 'what should the test device say next?' }, db);
ok(chatAmb?.pack.market.key === 'alpha' && /alpha/.test(chatAmb.note) && /beta/.test(chatAmb.note) && chatAmb.block.startsWith(chatAmb.note),
  'B9 product name matched, market ambiguous -> one-line note listing the markets, first market used', chatAmb && chatAmb.note);
ok(await pb.resolveChatBible({ text: 'make the Plain Product headline bigger' }, db) === null, 'B9 product without markets -> no pack');
ok(await pb.resolveChatBible({ text: 'make the headline bigger' }, db) === null, 'B9 no product mentioned -> no pack');
ok(await pb.resolveChatBible({ text: 'use the TD1x colour' }, db) === null, 'B9 product code only matches on a word boundary');
const chatExplicit = await pb.resolveChatBible({ text: 'anything', bible: { product: 'TD1', market: 'alpha', avatar: null, angle: null } }, db);
ok(chatExplicit?.pack.market.key === 'alpha' && chatExplicit.pack.job === 'chat', 'B9 explicit bible on a chat request -> chat pack for that market');
ok(await code(() => pb.resolveChatBible({ text: 'x', bible: { product: 'TD1', market: 'gamma' } }, db)) === 404, 'B9 explicit invalid chat bible -> 404');

void BibleError;
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
