// test-timeout: 300s
// PRODUCT BIBLE -> PIPELINE ROUTES, through the REAL routers (auth, permissions, DB), with Anthropic mocked.
// pipeline-bible.mjs proves the builders; this proves the routes actually feed them.
//
//   R1  GET  brief-pipeline/product-context: pack for a product with markets (?hint / ?market), legacy text otherwise,
//        404 for an unknown market
//   R2  POST brief-pipeline/generated/:id/enhance: the model receives the pack of the brief's STORED selection
//        (never the master brief); a brief of a product without markets still receives the legacy context;
//        an explicit invalid bible is a 404 before any model call
//   R3  POST brief-pipeline/generate-from-script + /queue: an invalid bible is refused before any row is written;
//        a valid queued selection is stamped on the job
//   R4  POST statics-generation/composer/copy-preview: copywriter prompt carries the static_copy pack + bible angle,
//        the response names the selection; a product without markets gets no pack
//   R5  POST statics-generation/generate + generate-batch: an invalid bible is a 404 before the background job;
//        a valid batch selection is stamped on the queue row
//   R7  POST brief-pipeline/generate-from-script (clone): detection classifies against the market's bible catalog,
//        the clone prompt carries the pack + bible angle, the brief row is stamped; no markets -> legacy prompt, NULL
//   R6  POST ai-developer/chat: a conversation naming a product with markets gets the chat pack in the system
//        prompt; one naming none does not; an explicit invalid selection is a 404
//
// Run: PB_TEST_PG=postgres://postgres@127.0.0.1:5433 node server/tests/product-bible/pipeline-bible-routes.mjs
import http from 'node:http';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PG = process.env.PB_TEST_PG || 'postgres://postgres@127.0.0.1:5433';
const DBNAME = `${process.env.BRAIN_TEST_DB_PREFIX || ''}pb_pipeline_routes`;
const DB = `${PG}/${DBNAME}`;

let pass = 0; let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass += 1; console.log('PASS ', m); } else { fail += 1; console.log('FAIL ', m, x ? `\n      ${String(x).slice(0, 900)}` : ''); }
};

const admin = postgres(`${PG}/postgres`, { ssl: false, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${DBNAME}`);
await admin.end();
const mig = spawnSync(process.execPath, [join(REPO, 'server/migrations/run.js')], {
  env: { ...process.env, DATABASE_URL: DB, MIGRATE_SSL: '0', STORE_CODE: 'SA' }, encoding: 'utf8', timeout: 240000,
});
ok(mig.status === 0, 'migrations apply', `${mig.stdout}\n${mig.stderr}`.slice(-1200));

// ── Mock Anthropic (Messages API: plain JSON for create/fetch, SSE for streams) ──
const seen = [];
const replyFor = (body) => {
  const all = JSON.stringify(body);
  if (all.includes('You classify a video-ad transcript')) {
    // Detection: one real catalog avatar, one hallucinated angle (must be rejected).
    return JSON.stringify({ funnel: 'top_or_middle', avatar: all.includes('beta avatar 1') ? 'beta avatar 1' : null, angle: 'An Invented Angle' });
  }
  if (all.includes('senior direct-response copywriter')) {
    return JSON.stringify({ candidates: [{ concept: 'plain idea', headline: 'Sleep through the whole night.', subhead: null, bullets: [], cta: null, attribution: null }] });
  }
  return JSON.stringify({ hooks: [{ id: 'H1', text: 'A hook', mechanism: 'm' }], body: 'A body.', highlighted_text: [], edit_summary: 'ok' });
};
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* recorded as null */ }
    seen.push(body);
    if (body?.stream) {
      const msg = { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, 'message_start', { type: 'message_start', message: msg });
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      sse(res, 'message_stop', { type: 'message_stop' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body?.model || 'x', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: replyFor(body) }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
mock.listen(0);
await new Promise((r) => mock.once('listening', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => (String(url).startsWith('https://api.anthropic.com/') ? realFetch(`${MOCK}/v1/messages`, opts) : realFetch(url, opts));

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'development', JWT_ACCESS_SECRET: 'localdev', JWT_REFRESH_SECRET: 'localdev',
  MONEY_SWEEP_DISABLED: '1', TRACKING_SWEEPS_DISABLED: '1', DOMAIN_SWEEP_DISABLED: '1',
  ANTHROPIC_API_KEY: 'sk-ant-mock-key-for-the-harness', ANTHROPIC_BASE_URL: MOCK,
  // Required by the brief insert path (card routing); test values only, nothing is pushed anywhere.
  PRODUCT_CODES_JSON: JSON.stringify(Object.fromEntries(['TD1', 'PP1'].map((c, i) => [c, { default: i === 0, clickup: { videoListId: `list-${c}`, initialStatus: 'edit queue' }, frameio: { projectId: `p-${c}`, editingFolderId: `f-${c}` } }]))),
});

const db = postgres(DB, { ssl: false, onnotice: () => {}, max: 4 });
const { importMarketBible } = await import('../../src/services/productBible/bibleStore.js');
const { buildProductContextForBrief } = await import('../../src/utils/briefProductContext.js');
const { default: express } = await import('express');
const { default: briefRoutes } = await import('../../src/routes/briefPipeline.js');
const { default: staticsRoutes } = await import('../../src/routes/staticsGeneration.js');
const { default: funnelsRoutes, ensureTables: ensureFunnelTables } = await import('../../src/routes/funnels.js');
const { default: aiDevRoutes } = await import('../../src/routes/aiDeveloper.js');
const { signAccessToken } = await import('../../src/utils/jwt.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1/brief-pipeline', briefRoutes);
app.use('/api/v1/statics-generation', staticsRoutes);
app.use('/api/v1/funnels', funnelsRoutes);
app.use('/api/v1/ai-developer', aiDevRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`;

await ensureFunnelTables();
const [user] = await db`INSERT INTO users (email, first_name, last_name, email_verified) VALUES ('pb-routes@example.test', 'P', 'B', true) RETURNING id`;
const [role] = await db`INSERT INTO roles (name, permissions) VALUES ('pb-routes', ${db.json({ 'brief-pipeline': ['access'], 'statics-generation': ['access'], funnels: ['access'] })}) RETURNING id`;
await db`INSERT INTO user_roles (user_id, role_id) VALUES (${user.id}, ${role.id})`;
const H = { Authorization: `Bearer ${signAccessToken({ userId: user.id })}`, 'Content-Type': 'application/json' };
const get = (p) => fetch(`${BASE}${p}`, { headers: H });
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

const [dev] = await db`INSERT INTO product_profiles (name, short_name, product_code, price, big_promise, master_brief, product_images)
  VALUES ('Test Device', 'TDV', 'TD1', '$5', 'Legacy device promise', 'LEGACY MASTER BRIEF', '["https://example.test/img.png"]') RETURNING *`;
const [plain] = await db`INSERT INTO product_profiles (name, short_name, product_code, price, big_promise, master_brief)
  VALUES ('Plain Product', 'PP', 'PP1', '$10', 'Plain promise line', 'PLAIN MASTER BRIEF') RETURNING *`;
function fixture(market) {
  const md = [`# Bible: ${market}`, ''];
  for (let s = 0; s < 6; s += 1) md.push(`## ${s}. Section ${s}`, '', `Text ${market} ${s} [${market === 'alpha' ? 'Q0001' : 'Q0101'}].`, '');
  return {
    md: md.join('\n'),
    library: {
      avatars: [0, 1].map((i) => ({ id: `${market}_av${i}`, type: i ? 'sub' : 'lead', name: `${market} avatar ${i}`, situation: `${market} situation ${i}`, best_angle_ids: [`${market}_an${i}`] })),
      angles: [0, 1, 2].map((i) => ({ id: `${market}_an${i}`, name: `${market} angle ${i}`, tier: 'A', avatar_ids: [`${market}_av${i % 2}`], tone: 'calm',
        headline_examples: [`${market} headline ${i}a`, `${market} headline ${i}b`], sub_angles: [`${market} sub ${i}a`], banned_phrases: [`${market} banned ${i}`] })),
      test_queue: [{ rank: 1, angle_id: `${market}_an1` }],
    },
  };
}
const quotes = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: `Q${String(i + 1).padStart(4, '0')}`, funnel: 'alpha', quote: `alpha voice ${i}`, avatar: 'alpha_av0', hook_strength: 3 })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `Q${String(i + 101).padStart(4, '0')}`, funnel: 'beta', quote: `beta voice ${i}`, avatar: 'beta_av0', hook_strength: 3 })),
].map((q) => JSON.stringify(q)).join('\n');
for (const [k, label, order] of [['alpha', 'Alpha Pain', 0], ['beta', 'Beta Relief', 1]]) {
  const f = fixture(k);
  await importMarketBible({ productId: dev.id, marketKey: k, label, price: k === 'alpha' ? '$1' : '$2', sortOrder: order, markdown: f.md, library: f.library, quotesJsonl: quotes }, db);
}

// ── R1 ──
{
  const r = await get('/brief-pipeline/product-context/TD1?hint=Beta%20Relief');
  const j = await r.json();
  ok(r.status === 200 && j.bible?.selection?.market === 'beta' && j.context.includes('PRODUCT BIBLE CONTEXT') && /\[beta_av\d\]/.test(j.context) && !j.context.includes('LEGACY MASTER BRIEF'),
    'R1 product-context: pack for the hinted market, no master brief', JSON.stringify(j).slice(0, 500));
  const r2 = await get('/brief-pipeline/product-context/TD1?market=beta&avatar=beta_av1&angle=beta_an2');
  const j2 = await r2.json();
  ok(r2.status === 200 && j2.bible.selection.avatar === 'beta_av1' && j2.context.includes('[beta_an2]'), 'R1 product-context: explicit market/avatar/angle');
  ok((await get('/brief-pipeline/product-context/TD1?market=ghost')).status === 404, 'R1 product-context: unknown market -> 404');
  const r3 = await get('/brief-pipeline/product-context/PP1');
  const j3 = await r3.json();
  const [plainParsed] = await db`SELECT * FROM product_profiles WHERE id = ${plain.id}`;
  ok(r3.status === 200 && !('bible' in j3) && j3.context === buildProductContextForBrief(plainParsed) && j3.context.includes('PLAIN MASTER BRIEF'),
    'R1 product-context: product without markets -> legacy text, no bible key', JSON.stringify(j3).slice(0, 300));
}

// ── R2 ──
{
  const [b1] = await db`INSERT INTO brief_pipeline_generated (parent_creative_id, product_code, hooks, body, naming_convention, bible)
    VALUES ('MANUAL-X', 'TD1', '[]', 'body', 'TD1 - B0001 - NN - Alpha Pain - UGC', ${db.json({ product_id: dev.id, market: 'beta', avatar: 'beta_av1', angle: 'beta_an2', picked: { market: 'operator', avatar: 'operator', angle: 'operator' } })}) RETURNING id`;
  const [b2] = await db`INSERT INTO brief_pipeline_generated (parent_creative_id, product_code, hooks, body) VALUES ('MANUAL-Y', 'PP1', '[]', 'body') RETURNING id`;
  const n0 = seen.length;
  const r = await post(`/brief-pipeline/generated/${b1.id}/enhance`, { instruction: 'make hook 1 punchier', currentHooks: [{ text: 'h' }], currentBody: 'body' });
  const sent = JSON.stringify(seen[seen.length - 1] || {});
  ok(r.status === 200 && seen.length === n0 + 1 && sent.includes('[beta_av1]') && sent.includes('[beta_an2]') && !sent.includes('LEGACY MASTER BRIEF') && !/alpha/.test(sent),
    'R2 enhance: model gets the pack of the brief\'s STORED selection (not the name\'s market, not the master brief)', sent.slice(0, 600));
  const r2 = await post(`/brief-pipeline/generated/${b2.id}/enhance`, { instruction: 'make hook 1 punchier', currentHooks: [{ text: 'h' }], currentBody: 'body' });
  const sent2 = JSON.stringify(seen[seen.length - 1] || {});
  ok(r2.status === 200 && sent2.includes('PLAIN MASTER BRIEF') && !sent2.includes('PRODUCT BIBLE'), 'R2 enhance: product without markets keeps the legacy context');
  const n1 = seen.length;
  const r3 = await post(`/brief-pipeline/generated/${b1.id}/enhance`, { instruction: 'x', bible: { product: 'TD1', market: 'beta', angle: 'ghost' } });
  ok(r3.status === 404 && seen.length === n1, 'R2 enhance: explicit invalid angle -> 404, no model call', `${r3.status} calls=${seen.length - n1}`);
}

// ── R3 ──
{
  const before = (await db`SELECT count(*)::int AS n FROM brief_pipeline_winners`)[0].n;
  const r = await post('/brief-pipeline/generate-from-script', { script: 'This is a long enough script for the pipeline to accept it.', productId: dev.id, productCode: 'TD1', mode: 'clone', bible: { product: 'TD1', market: 'gamma' } });
  const after = (await db`SELECT count(*)::int AS n FROM brief_pipeline_winners`)[0].n;
  ok(r.status === 404 && after === before, 'R3 generate-from-script: invalid market -> 404, no winner row written', `${r.status} ${before}->${after}`);
  const r2 = await post('/brief-pipeline/generate-from-script', { script: 'This is a long enough script for the pipeline to accept it.', productId: plain.id, productCode: 'PP1', mode: 'clone', bible: { product: 'TD1', market: 'beta' } });
  ok(r2.status === 400, 'R3 generate-from-script: bible for a different product than the request -> 400', r2.status);
  const q = await post('/brief-pipeline/queue', { items: [{ brandSpyAdId: 'bs-1', adArchiveId: '111', headline: 'x' }], productId: dev.id, productCode: 'TD1', bible: { product: 'TD1', market: 'beta', avatar: null, angle: 'beta_an0' } });
  const qj = await q.json();
  const [job] = await db`SELECT bible FROM brief_generation_jobs WHERE id = ${qj.jobs?.[0]?.id || '00000000-0000-0000-0000-000000000000'}`;
  ok(q.status === 200 && job?.bible?.market === 'beta' && job.bible.angle === 'beta_an0', 'R3 queue: selection stamped on the job', JSON.stringify({ qj, job }).slice(0, 300));
  const q2 = await post('/brief-pipeline/queue', { items: [{ brandSpyAdId: 'bs-2', adArchiveId: '222' }], productId: dev.id, bible: { product: 'TD1', market: 'beta', angle: 'nope' } });
  const [{ n }] = await db`SELECT count(*)::int AS n FROM brief_generation_jobs WHERE ad_archive_id = '222'`;
  ok(q2.status === 404 && n === 0, 'R3 queue: invalid angle -> 404, nothing queued');
  const q3 = await post('/brief-pipeline/queue', { items: [{ brandSpyAdId: 'bs-3', adArchiveId: '333' }], productId: plain.id });
  const [job3] = await db`SELECT bible FROM brief_generation_jobs WHERE ad_archive_id = '333'`;
  ok(q3.status === 200 && job3 && job3.bible === null, 'R3 queue without bible: job queued exactly as before (bible NULL)');
}

// ── R4 ──
{
  const n0 = seen.length;
  const r = await post('/statics-generation/composer/copy-preview', { product_id: dev.id, format: 'statement', bible: { product: 'TD1', market: 'beta', avatar: 'beta_av0', angle: 'beta_an0' } });
  const j = await r.json();
  const sent = JSON.stringify(seen[seen.length - 1] || {});
  ok(r.status === 200 && seen.length === n0 + 1 && j.data.bible?.market === 'beta' && j.data.angle === 'beta angle 0',
    'R4 copy-preview: response names the bible selection and angle', JSON.stringify(j).slice(0, 400));
  ok(sent.includes('PRODUCT BIBLE CONTEXT') && sent.includes('ANGLE: beta angle 0') && sent.includes('beta banned 0') && !sent.includes('Legacy device promise') && !/alpha/.test(sent),
    'R4 copy-preview: copywriter prompt = static_copy pack + bible angle, no legacy promise, no other market', sent.slice(0, 500));
  const r2 = await post('/statics-generation/composer/copy-preview', { product_id: plain.id, format: 'statement' });
  const sent2 = JSON.stringify(seen[seen.length - 1] || {});
  ok(r2.status === 200 && !sent2.includes('PRODUCT BIBLE') && sent2.includes('Plain promise line') && !('bible' in (await r2.json()).data), 'R4 copy-preview: product without markets -> legacy prompt');
  ok((await post('/statics-generation/composer/copy-preview', { product_id: dev.id, bible: { product: 'TD1', market: 'beta', avatar: 'alpha_av0' } })).status === 404, 'R4 copy-preview: other market\'s avatar -> 404');
}

// ── R5 ──
{
  const r = await post('/statics-generation/generate', { reference_image_url: 'https://example.test/ref.png', product: { id: dev.id, name: 'Test Device' }, product_id: dev.id, bible: { product: 'TD1', market: 'gamma' } });
  const j = await r.json();
  ok(r.status === 404 && !j.data?.taskId, 'R5 generate: invalid bible -> 404 before any background job', JSON.stringify(j));
  const refs = [{ image_url: 'https://example.test/ref.png' }];
  const b = await post('/statics-generation/generate-batch', { items: [{ product_id: dev.id, references: refs, bible: { product: 'TD1', market: 'alpha', avatar: null, angle: null } }] });
  const bj = await b.json();
  const [row] = await db`SELECT bible, status FROM statics_queue WHERE id = ${bj.data?.queued?.[0]?.id || '00000000-0000-0000-0000-000000000000'}`;
  ok(b.status === 200 && row?.bible?.market === 'alpha', 'R5 generate-batch: selection stamped on the queue row', JSON.stringify(bj).slice(0, 300));
  const before = (await db`SELECT count(*)::int AS n FROM statics_queue`)[0].n;
  const b2 = await post('/statics-generation/generate-batch', { items: [{ product_id: plain.id, references: refs }, { product_id: dev.id, references: refs, bible: { product: 'TD1', market: 'beta', angle: 'ghost' } }] });
  const after = (await db`SELECT count(*)::int AS n FROM statics_queue`)[0].n;
  ok(b2.status === 404 && after === before, 'R5 generate-batch: one invalid selection -> 404 and NOTHING enqueued', `${b2.status} ${before}->${after}`);
}

// ── R6 ──
{
  const f = await post('/funnels', { name: 'Bible chat', slug: 'bible-chat' });
  const FA = (await f.json())?.data?.id;
  const p = await post(`/funnels/${FA}/pages`, { title: 'Page', slug: '/', type: 'generic' });
  const PA = (await p.json())?.data?.id;
  const chat = async (body) => {
    const r = await post('/ai-developer/chat', { funnel_id: FA, page_id: PA, ...body });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, text: ct.includes('event-stream') ? await r.text() : JSON.stringify(await r.json()) };
  };
  let n0 = seen.length;
  const c1 = await chat({ messages: [{ role: 'user', content: 'Rewrite the hero for the TD1 buyers who want relief' }] });
  const sys1 = String(seen[seen.length - 1]?.system || '');
  ok(c1.status === 200 && seen.length === n0 + 1 && sys1.includes('PRODUCT BIBLE') && sys1.includes('Market: Beta Relief') && !/alpha/.test(sys1.split('PRODUCT BIBLE (read-only')[1] || ''),
    'R6 chat: conversation naming a product with markets -> chat pack for the inferred market', sys1.slice(-400));
  n0 = seen.length;
  const c2 = await chat({ messages: [{ role: 'user', content: 'Make the headline bigger' }] });
  const sys2 = String(seen[seen.length - 1]?.system || '');
  ok(c2.status === 200 && seen.length === n0 + 1 && !sys2.includes('PRODUCT BIBLE'), 'R6 chat: no product named -> system prompt unchanged');
  n0 = seen.length;
  const c3 = await chat({ messages: [{ role: 'user', content: 'x' }], bible: { product: 'TD1', market: 'ghost' } });
  ok(c3.status === 404 && seen.length === n0, 'R6 chat: explicit invalid selection -> 404, no model call', c3.text.slice(0, 200));
}

// ── R7 ──
{
  const waitBrief = async (winnerId) => {
    for (let i = 0; i < 60; i += 1) {
      const rows = await db`SELECT id, bible, avatar, angle, naming_convention FROM brief_pipeline_generated WHERE winner_id = ${winnerId}`;
      if (rows.length) return rows[0];
      const [w] = await db`SELECT status, generation_error FROM brief_pipeline_winners WHERE id = ${winnerId}`;
      if (w?.generation_error) return { error: w.generation_error };
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };
  const script = 'I tried everything for years and nothing worked until I found this. Here is what changed for me and why it matters for you.';
  const n0 = seen.length;
  const r = await post('/brief-pipeline/generate-from-script', { script, productId: dev.id, productCode: 'TD1', mode: 'clone', numVariations: 1,
    bible: { product: 'TD1', market: 'beta', avatar: null, angle: 'beta_an0' } });
  const j = await r.json();
  const brief = j.winner_id ? await waitBrief(j.winner_id) : null;
  const calls = seen.slice(n0).map((b) => JSON.stringify(b));
  const detect = calls.find((c) => c.includes('You classify a video-ad transcript')) || '';
  const clone = calls.find((c) => c.includes('# ORIGINAL COMPETITOR SCRIPT') || c.includes('ORIGINAL_BODY') || c.includes('clone_fidelity_notes')) || '';
  ok(r.status === 200 && brief && !brief.error, 'R7 clone with a bible selection produced a brief', JSON.stringify({ j, brief }).slice(0, 400));
  ok(detect.includes('beta avatar 0') && detect.includes('beta angle 2') && !detect.includes('Founder POV') && !/alpha/.test(detect),
    'R7 detection catalog = the market\'s bible avatars + angles (not DEFAULT_AVATARS, no other market)', detect.slice(0, 400));
  ok(clone.includes('PRODUCT BIBLE CONTEXT') && clone.includes('[beta_av1]') && clone.includes('[beta_an0]') && clone.includes('beta headline 0a') && !clone.includes('LEGACY MASTER BRIEF') && !/alpha/.test(clone),
    'R7 clone prompt: pack for the DETECTED avatar + operator angle, bible angle details, no master brief, no other market', clone.slice(0, 500));
  ok(brief?.bible?.market === 'beta' && brief.bible.avatar === 'beta_av1' && brief.bible.angle === 'beta_an0'
    && brief.bible.picked?.avatar === 'detected' && brief.bible.picked?.angle === 'operator' && brief.avatar === 'beta avatar 1',
  'R7 brief row stamped with {market, avatar, angle, picked}; avatar column = bible avatar title', JSON.stringify(brief));

  const n1 = seen.length;
  const r2 = await post('/brief-pipeline/generate-from-script', { script, productId: plain.id, productCode: 'PP1', mode: 'clone', numVariations: 1 });
  const j2 = await r2.json();
  const brief2 = j2.winner_id ? await waitBrief(j2.winner_id) : null;
  const calls2 = seen.slice(n1).map((b) => JSON.stringify(b));
  const clone2 = calls2.find((c) => c.includes('PLAIN MASTER BRIEF') && !c.includes('You classify')) || '';
  ok(brief2 && !brief2.error && brief2.bible === null && clone2 && !calls2.some((c) => c.includes('PRODUCT BIBLE')),
    'R7 product without markets: legacy clone prompt (master brief), brief bible NULL', JSON.stringify(brief2));
}

server.close(); mock.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
