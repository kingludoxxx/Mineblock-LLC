// Verification harness for the canvas page-thumbnail core
// (routes/pageThumbnails.js: shared-chromium screenshot + mem/disk cache).
// Drives the REAL generateThumbnail/readCache/writeCache against embedded PG
// with a seeded minimal funnel + pages. Asserts: a JPEG buffer > 1KB lands in
// the cache dir, a second read hits the cache (no new screenshot), ONE
// browser launch across multiple shots, stale-file sweep on page edit, and
// fail-open (null, not throw) on a poisoned page.
//
// Run:  node server/tests/funnels/page-thumbnails.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';
// Short idle window so the idle-close test (T11) runs in seconds. Every gap
// between consecutive shots in this harness is a few ms of DB work, far
// under 1500ms, so earlier launch-count assertions stay valid.
process.env.THUMB_BROWSER_IDLE_MS = '1500';

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const q = (text, params = []) => sql.unsafe(text, params);

const {
  generateThumbnail,
  screenshotHtml,
  readCache,
  writeCache,
  cacheKeyFor,
  closeBrowser,
  isBrowserActive,
  renderAndCacheDeduped,
  _stats,
} = await import('../../src/routes/pageThumbnails.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const CACHE_DIR = path.join(os.tmpdir(), 'page-thumbs');
const FID = 'fnl_thumbtest';
const PID_A = 'pg_thumb_a';
const PID_B = 'pg_thumb_b';

// ── Seed: minimal funnel + two pages (funnels DDL already exists on this DB
// from the funnels test suites; IF NOT EXISTS semantics preserved by DELETE
// + INSERT re-seed) ─────────────────────────────────────────────────────────
await q(`DELETE FROM funnel_pages WHERE funnel_id = $1`, [FID]);
await q(`DELETE FROM funnels WHERE id = $1`, [FID]);
await q(
  `INSERT INTO funnels (id, slug, name, status, seo, flow_layout)
   VALUES ($1, 'thumb-test', 'Thumb Test', 'draft', '{}', '{"nodes":[],"edges":[]}')`,
  [FID]
);
const BLOCKS = JSON.stringify([
  { id: 'b1', type: 'hero', props: { headline: 'Thumbnail Test Hero', subheadline: 'A seeded page' } },
  { id: 'b2', type: 'heading', props: { text: 'Section heading' } },
  { id: 'b3', type: 'text', props: { text: 'Body copy for the miniature.' } },
  { id: 'b4', type: 'button', props: { label: 'Buy now', href: '/next' } },
]);
await q(
  `INSERT INTO funnel_pages (id, funnel_id, slug, type, title, status, blocks)
   VALUES ($1, $2, '/', 'lead', 'Thumb A', 'published', $3),
          ($4, $2, '/b', 'checkout', 'Thumb B', 'published', $3)`,
  [PID_A, FID, BLOCKS, PID_B]
);

// Same read path as the route: funnel row, page row, id->slug map.
const funnel = (await q(`SELECT * FROM funnels WHERE id = $1`, [FID]))[0];
const pageA = (await q(`SELECT * FROM funnel_pages WHERE funnel_id = $1 AND id = $2`, [FID, PID_A]))[0];
const pageB = (await q(`SELECT * FROM funnel_pages WHERE funnel_id = $1 AND id = $2`, [FID, PID_B]))[0];
const all = await q(`SELECT id, slug FROM funnel_pages WHERE funnel_id = $1 AND archived = FALSE`, [FID]);
const pagesById = new Map(all.map((p) => [p.id, { slug: p.slug }]));

// ── T1: render + screenshot a seeded page → JPEG buffer > 1KB ──────────────
const buf = await generateThumbnail(pageA, funnel, pagesById);
check('T1 generateThumbnail returns a Buffer', Buffer.isBuffer(buf), String(buf));
check('T1 buffer > 1KB', buf && buf.length > 1024, `len=${buf?.length}`);
check('T1 JPEG magic bytes (ffd8ff)', buf && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  buf ? buf.subarray(0, 3).toString('hex') : 'null');

// ── T2: writeCache lands the file in os.tmpdir()/page-thumbs ───────────────
writeCache(pageA, buf);
const fileA = path.join(CACHE_DIR, `${cacheKeyFor(pageA)}.jpg`);
check('T2 cache file exists', existsSync(fileA), fileA);
check('T2 cache file > 1KB', existsSync(fileA) && statSync(fileA).size > 1024,
  existsSync(fileA) ? `size=${statSync(fileA).size}` : 'missing');

// ── T3: second call hits the cache — NO new screenshot ─────────────────────
const shotsBefore = _stats.screenshots;
const cached = readCache(pageA);
check('T3 readCache returns the buffer', Buffer.isBuffer(cached) && cached.length === buf.length,
  `len=${cached?.length} vs ${buf.length}`);
check('T3 no new screenshot on cache hit', _stats.screenshots === shotsBefore,
  `shots ${shotsBefore} -> ${_stats.screenshots}`);

// ── T4: ONE shared browser across multiple shots ───────────────────────────
const bufB = await generateThumbnail(pageB, funnel, pagesById);
check('T4 second page also renders', Buffer.isBuffer(bufB) && bufB.length > 1024, `len=${bufB?.length}`);
check('T4 exactly one browser launch across all shots', _stats.launches === 1,
  `launches=${_stats.launches}`);

// ── T5: page edit (updated_at bump) → stale key misses; old file swept ─────
await q(`UPDATE funnel_pages SET title = 'Thumb A v2', updated_at = NOW() + interval '1 second' WHERE id = $1`, [PID_A]);
const pageA2 = (await q(`SELECT * FROM funnel_pages WHERE id = $1`, [PID_A]))[0];
check('T5 bumped updated_at changes the cache key', cacheKeyFor(pageA2) !== cacheKeyFor(pageA));
check('T5 stale key misses the cache', readCache(pageA2) === null);
writeCache(pageA2, buf);
check('T5 old file swept after new write', !existsSync(fileA), fileA);
check('T5 new file present', existsSync(path.join(CACHE_DIR, `${cacheKeyFor(pageA2)}.jpg`)));

// ── T6: garbage blocks do not throw (renderPageHtml is fail-open) ──────────
await q(`UPDATE funnel_pages SET blocks = '"garbage-not-an-array"' WHERE id = $1`, [PID_B]);
const pageBGarbage = (await q(`SELECT * FROM funnel_pages WHERE id = $1`, [PID_B]))[0];
let garbageOutcome = 'threw';
try {
  const g = await generateThumbnail(pageBGarbage, funnel, pagesById);
  garbageOutcome = g === null ? 'null' : (Buffer.isBuffer(g) ? 'buffer' : String(g));
} catch (err) {
  garbageOutcome = `threw: ${err.message}`;
}
check('T6 garbage blocks -> no throw (buffer or null)',
  garbageOutcome === 'null' || garbageOutcome === 'buffer', garbageOutcome);

// ── T7: a page that BREAKS the renderer → null, not throw (fail-open) ──────
const poisoned = new Proxy({}, { get() { throw new Error('poisoned page row'); } });
let poisonOutcome = 'threw';
try {
  const p = await generateThumbnail(poisoned, funnel, pagesById);
  poisonOutcome = p === null ? 'null' : 'unexpected-buffer';
} catch (err) {
  poisonOutcome = `threw: ${err.message}`;
}
check('T7 poisoned page -> null, not throw', poisonOutcome === 'null', poisonOutcome);

// ── T8: in-flight dedupe — two concurrent renders, ONE screenshot ──────────
await q(`UPDATE funnel_pages SET blocks = $2, updated_at = NOW() + interval '2 seconds' WHERE id = $1`, [PID_B, BLOCKS]);
const pageB2 = (await q(`SELECT * FROM funnel_pages WHERE id = $1`, [PID_B]))[0];
const shotsBeforeDedupe = _stats.screenshots;
const [d1, d2] = await Promise.all([
  renderAndCacheDeduped(pageB2, funnel, pagesById),
  renderAndCacheDeduped(pageB2, funnel, pagesById),
]);
check('T8 both concurrent callers get a buffer', Buffer.isBuffer(d1) && Buffer.isBuffer(d2));
check('T8 same-page concurrency took exactly ONE screenshot',
  _stats.screenshots === shotsBeforeDedupe + 1,
  `shots ${shotsBeforeDedupe} -> ${_stats.screenshots}`);
check('T8 both callers share the same bytes', d1 && d2 && d1.equals(d2));
check('T8 the deduped render landed in the cache', readCache(pageB2) !== null);

// ── T9: hostile while(true) script — JS is OFF, shot stays fast ────────────
await q(`UPDATE funnel_pages SET custom_js = 'while(true){}', updated_at = NOW() + interval '3 seconds' WHERE id = $1`, [PID_B]);
const pageLoop = (await q(`SELECT * FROM funnel_pages WHERE id = $1`, [PID_B]))[0];
const t9start = Date.now();
const loopBuf = await generateThumbnail(pageLoop, funnel, pagesById);
const t9ms = Date.now() - t9start;
check('T9 while(true) page still produces a thumbnail (JS disabled)',
  Buffer.isBuffer(loopBuf) && loopBuf.length > 1024, `len=${loopBuf?.length}`);
check('T9 shot completed fast, not via timeout', t9ms < 5000, `took ${t9ms}ms`);

// ── T10: private/loopback asset in the page is aborted by the filter ───────
await q(
  `UPDATE funnel_pages SET custom_js = '', custom_html = '<img src="http://127.0.0.1:9/x"><img src="http://169.254.169.254/latest/meta-data/">',
   updated_at = NOW() + interval '4 seconds' WHERE id = $1`,
  [PID_B]
);
const pageSsrf = (await q(`SELECT * FROM funnel_pages WHERE id = $1`, [PID_B]))[0];
const abortedBefore = _stats.abortedPrivate;
const ssrfBuf = await generateThumbnail(pageSsrf, funnel, pagesById);
check('T10 page with private-host assets still screenshots', Buffer.isBuffer(ssrfBuf), String(ssrfBuf));
check('T10 private-host requests were aborted by the filter',
  _stats.abortedPrivate >= abortedBefore + 2,
  `abortedPrivate ${abortedBefore} -> ${_stats.abortedPrivate}`);

// ── T11: idle-close — browser closes after the idle window, relaunches ─────
check('T11 browser is active right after a shot', isBrowserActive() === true);
const launchesBeforeIdle = _stats.launches;
await new Promise((r) => setTimeout(r, 2700)); // idle window is 1500ms
check('T11 idle timer closed the browser', isBrowserActive() === false);
const afterIdleBuf = await generateThumbnail(pageA2, funnel, pagesById);
check('T11 next request relaunches and succeeds',
  Buffer.isBuffer(afterIdleBuf) && afterIdleBuf.length > 1024, `len=${afterIdleBuf?.length}`);
check('T11 relaunch counted (exactly one more launch)',
  _stats.launches === launchesBeforeIdle + 1,
  `launches ${launchesBeforeIdle} -> ${_stats.launches}`);

// ── cleanup ────────────────────────────────────────────────────────────────
await q(`DELETE FROM funnel_pages WHERE funnel_id = $1`, [FID]);
await q(`DELETE FROM funnels WHERE id = $1`, [FID]);
await closeBrowser();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
