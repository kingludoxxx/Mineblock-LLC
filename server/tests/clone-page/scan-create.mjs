// Verification harness for CLONE-A-PAGE (routes/pageClone.js).
// Drives the exported scan pipeline DIRECTLY, then a full HTTP round through
// a bare express app mounting the exported handlers behind a STUB req.user
// (the real router keeps authenticate + requirePermission — nothing here
// weakens it). Embedded PG at 127.0.0.1:5433.
//
// Run:  node server/tests/clone-page/scan-create.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const express = (await import(`${NM}/express/index.js`)).default;

const {
  cleanHtml, splitSections, rewriteRelativeUrls, scanHtml,
  scanHandler, createHandler,
} = await import('../../src/routes/pageClone.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// ── Messy fixture: scripts, fb pixel (script + noscript img), gtag, tiktok,
//    comments, title, meta junk, preload link, relative img/href ───────────
const FIXTURE = `<!DOCTYPE html>
<html>
<head>
  <title>  Glow Serum —
    Landing </title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="source junk">
  <meta property="og:title" content="source junk">
  <link rel="preconnect" href="https://fonts.gstatic.com">
  <link rel="preload" as="font" href="/fonts/x.woff2">
  <link rel="dns-prefetch" href="//cdn.example.com">
  <link rel="stylesheet" href="/css/site.css">
  <!-- build 2211 -->
  <script>
    !function(f,b,e,v,n,t,s){/* meta pixel bootstrap */}(window,document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init','123456');fbq('track','PageView');
  </script>
  <noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=123456&ev=PageView&noscript=1"/></noscript>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());</script>
  <script src="https://analytics.tiktok.com/i18n/pixel/events.js"></script>
  <script src="/js/app.js"></script>
</head>
<body>
  <!-- hero starts -->
  <header class="hero">
    <img src="/img/hero.jpg" alt="Hero">
    <h1>Glow like never before</h1>
    <a href="/buy">Buy now</a>
    <a href="https://example.com/kept">absolute stays</a>
    <img src="data:image/gif;base64,R0lGOD" alt="inline stays">
  </header>
  <section id="benefits">
    <img srcset="/img/a.jpg 1x, /img/a@2x.jpg 2x" src="/img/a.jpg" alt="A">
    <p>Benefit copy &amp; more</p>
    <script>console.log('inline junk in body')</script>
  </section>
  <footer>
    <p>© footer text</p>
  </footer>
  <img height="1" width="1" src="https://www.facebook.com/tr?id=999&ev=Lead">
</body>
</html>`;

// ── T1: direct pipeline — clean + split, no original_url ────────────────────
{
  const { sections, stats } = scanHtml(FIXTURE, {});
  const all = sections.map((s) => s.html).join('\n');
  check('T1 split into 3 sections (header/section/footer)', sections.length === 3,
    `got ${sections.length}: ${sections.map((s) => s.text_preview.slice(0, 20)).join(' | ')}`);
  check('T1 no <script anywhere in sections', !/<script/i.test(all));
  check('T1 no facebook/gtm/tiktok references left', !/(facebook|googletagmanager|tiktok)/i.test(all));
  check('T1 no comments left', !/<!--/.test(all));
  check('T1 no <title> left', !/<title/i.test(all));
  check('T1 title captured + whitespace-collapsed', stats.title === 'Glow Serum — Landing', JSON.stringify(stats.title));
  check('T1 scripts_removed counts the 3 junk scripts', stats.scripts_removed === 3, `got ${stats.scripts_removed}`);
  check('T1 pixels_stripped counts fb script + gtm loader + tiktok + noscript img + bare img', stats.pixels_stripped === 5, `got ${stats.pixels_stripped}`);
  check('T1 comments_removed counts both comments', stats.comments_removed === 2, `got ${stats.comments_removed}`);
  check('T1 relative src untouched without original_url', /src="\/img\/hero\.jpg"/.test(all));
  check('T1 section fields present', sections.every((s) => Number.isInteger(s.index) && typeof s.html === 'string' && typeof s.text_preview === 'string' && s.approx_bytes > 0));
  check('T1 text_preview capped at 120 chars', sections.every((s) => s.text_preview.length <= 120));
  check('T1 entity decoded in preview', sections[1].text_preview.includes('Benefit copy & more'), sections[1].text_preview);
}

// ── T2: original_url absolutizes relative src/href/srcset, leaves the rest ─
{
  const { sections } = scanHtml(FIXTURE, { originalUrl: 'https://shop.example.com/pages/glow' });
  const all = sections.map((s) => s.html).join('\n');
  check('T2 relative img absolutized', all.includes('src="https://shop.example.com/img/hero.jpg"'), all.match(/src="[^"]*hero[^"]*"/)?.[0]);
  check('T2 relative href absolutized', all.includes('href="https://shop.example.com/buy"'));
  check('T2 srcset absolutized both entries', all.includes('srcset="https://shop.example.com/img/a.jpg 1x, https://shop.example.com/img/a@2x.jpg 2x"'), all.match(/srcset="[^"]*"/)?.[0]);
  check('T2 absolute href untouched', all.includes('href="https://example.com/kept"'));
  check('T2 data: URI untouched', all.includes('src="data:image/gif;base64,R0lGOD"'));
}

// ── T3: <main> takes precedence over <body> children ───────────────────────
{
  const html = '<body><div class="chrome">nav</div><main><section>a</section><section>b</section></main></body>';
  const sections = splitSections(html);
  check('T3 main present → its children are the sections', sections.length === 2 && sections[0].html === '<section>a</section>', JSON.stringify(sections.map((s) => s.html)));
}

// ── T4: fragment with no body/main still sections ───────────────────────────
{
  const sections = splitSections('<div>one</div>\n<div>two</div>');
  check('T4 bare fragment splits on top-level divs', sections.length === 2, `got ${sections.length}`);
  const single = splitSections('just loose text, no tags');
  check('T4 tagless input becomes one section', single.length === 1 && single[0].html === 'just loose text, no tags');
  check('T4 empty input → zero sections', splitSections('   ').length === 0);
}

// ── T5: kept meta charset/viewport survive cleaning; junk meta/link gone ────
{
  const { html } = cleanHtml(FIXTURE);
  check('T5 charset meta kept', /<meta charset="utf-8">/.test(html));
  check('T5 viewport meta kept', /name="viewport"/.test(html));
  check('T5 description/og meta removed', !/description|og:title/.test(html));
  check('T5 preconnect/preload/dns-prefetch links removed', !/preconnect|preload|dns-prefetch/.test(html));
  check('T5 stylesheet link kept', /rel="stylesheet"/.test(html));
}

// ── HTTP round: bare app + stub user (real router keeps real auth) ──────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, _res, next) => { req.user = { id: 'usr_harness', role: 'superadmin' }; next(); });
app.post('/api/v1/page-clone/scan', scanHandler);
app.post('/api/v1/page-clone/create', createHandler);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/v1/page-clone`;
const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, json };
};

// ── T6: /scan happy path over HTTP (paste) ─────────────────────────────────
{
  const r = await post('/scan', { html: FIXTURE, original_url: 'https://shop.example.com/pages/glow' });
  const d = r.json?.data;
  check('T6 /scan 200 with sections+stats', r.status === 200 && d?.sections?.length === 3 && d?.stats?.title === 'Glow Serum — Landing', `status ${r.status}`);
  check('T6 /scan sections carry absolutized urls', d?.sections?.some((s) => s.html.includes('https://shop.example.com/img/hero.jpg')));
}

// ── T7: /scan via file_base64 upload; filename title fallback ──────────────
{
  const noTitle = FIXTURE.replace(/<title[\s\S]*?<\/title\s*>/i, '');
  const r = await post('/scan', {
    file_base64: Buffer.from(noTitle, 'utf8').toString('base64'),
    filename: 'glow-landing.html',
  });
  check('T7 upload scans; filename (minus ext) becomes title fallback', r.status === 200 && r.json?.data?.stats?.title === 'glow-landing', JSON.stringify(r.json?.data?.stats));
}

// ── T8: /scan error paths ──────────────────────────────────────────────────
{
  const empty = await post('/scan', {});
  check('T8 no input → 400', empty.status === 400, `got ${empty.status}`);
  const badUrl = await post('/scan', { html: '<div>x</div>', original_url: 'not a url' });
  check('T8 invalid original_url → 400', badUrl.status === 400, `got ${badUrl.status}`);
  const jsUrl = await post('/scan', { html: '<div>x</div>', original_url: 'javascript:alert(1)' });
  check('T8 non-http original_url → 400', jsUrl.status === 400, `got ${jsUrl.status}`);
  const zip = await post('/scan', {
    file_base64: Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(64)]).toString('base64'),
    filename: 'export.zip',
  });
  check('T8 zip upload → 422 with actionable message', zip.status === 422 && /unzip/i.test(zip.json?.error || ''), `got ${zip.status}: ${zip.json?.error}`);
  const zipByMagic = await post('/scan', {
    file_base64: Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(64)]).toString('base64'),
    filename: 'renamed.html',
  });
  check('T8 zip detected by magic bytes even with .html name → 422', zipByMagic.status === 422, `got ${zipByMagic.status}`);
  const big = await post('/scan', { html: '<div>' + 'x'.repeat(10 * 1024 * 1024 + 100) + '</div>' });
  check('T8 >10MB input → 413', big.status === 413, `got ${big.status}`);
  const chunk = '<section>' + 'y'.repeat(800 * 1024) + '</section>';
  const fat = await post('/scan', { html: `<body>${chunk}${chunk}${chunk}</body>` });
  check('T8 cleaned output >2MB → 413', fat.status === 413, `got ${fat.status}`);
}

// ── T9: /create writes a draft generic page with section blocks ────────────
const FID = 'fnl_clonetest';
await sql`DELETE FROM funnel_pages WHERE funnel_id = ${FID}`;
await sql`DELETE FROM funnels WHERE id = ${FID}`;
await sql`INSERT INTO funnels (id, slug, name) VALUES (${FID}, 'clone-test', 'Clone test')`;
{
  const r = await post('/create', {
    funnel_id: FID,
    title: 'Glow Serum — Landing',
    sections: ['<header><h1>Glow</h1></header>', '<section><p>Body</p></section>'],
  });
  const p = r.json?.data;
  check('T9 create → 201', r.status === 201, `got ${r.status}: ${JSON.stringify(r.json)}`);
  check('T9 slug slugified from title', p?.slug === '/glow-serum-landing', p?.slug);
  check('T9 type generic / status draft', p?.type === 'generic' && p?.status === 'draft', `${p?.type}/${p?.status}`);
  check('T9 first live page becomes home', p?.is_home === true);
  const blocks = typeof p?.blocks === 'string' ? JSON.parse(p.blocks) : p?.blocks;
  check('T9 blocks are section blocks with verbatim html', Array.isArray(blocks) && blocks.length === 2 && blocks.every((b) => b.type === 'section') && blocks[0].props.html === '<header><h1>Glow</h1></header>', JSON.stringify(blocks));
  const row = (await sql`SELECT * FROM funnel_pages WHERE id = ${p.id}`)[0];
  check('T9 row actually persisted in PG', !!row && row.slug === '/glow-serum-landing');

  // Same title again → numeric-suffix slug, not a 409/500.
  const r2 = await post('/create', { funnel_id: FID, title: 'Glow Serum — Landing', sections: ['<div>v2</div>'] });
  check('T9 slug collision → -2 suffix', r2.status === 201 && r2.json?.data?.slug === '/glow-serum-landing-2', `${r2.status} ${r2.json?.data?.slug}`);
  check('T9 second page is NOT home', r2.json?.data?.is_home === false);
  const r3 = await post('/create', { funnel_id: FID, title: 'Glow Serum — Landing', sections: ['<div>v3</div>'] });
  check('T9 third collision → -3 suffix', r3.status === 201 && r3.json?.data?.slug === '/glow-serum-landing-3', `${r3.status} ${r3.json?.data?.slug}`);
}

// ── T10: /create error paths ───────────────────────────────────────────────
{
  const noFunnel = await post('/create', { funnel_id: 'fnl_nope', title: 'X', sections: ['<div>x</div>'] });
  check('T10 unknown funnel → 404', noFunnel.status === 404, `got ${noFunnel.status}`);
  const noSections = await post('/create', { funnel_id: FID, title: 'X', sections: [] });
  check('T10 empty sections → 400', noSections.status === 400, `got ${noSections.status}`);
  const badSection = await post('/create', { funnel_id: FID, title: 'X', sections: [42] });
  check('T10 non-string section → 400', badSection.status === 400, `got ${badSection.status}`);
  const noTitle = await post('/create', { funnel_id: FID, title: '  ', sections: ['<div>x</div>'] });
  check('T10 blank title → 400', noTitle.status === 400, `got ${noTitle.status}`);
  const fat = await post('/create', { funnel_id: FID, title: 'Fat', sections: ['<div>' + 'z'.repeat(2 * 1024 * 1024 + 10) + '</div>'] });
  check('T10 blocks over 2MB cap → 413', fat.status === 413, `got ${fat.status}`);
  const proto = await post('/create', { funnel_id: FID, title: 'Proto', sections: ['<div>ok</div>'] });
  check('T10 sane create still works after failures', proto.status === 201);
}

// ── T11: malformed JSON body does not crash the route (parser 4xx) ─────────
{
  const r = await fetch(`${BASE}/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  check('T11 malformed JSON → 4xx, server alive', r.status >= 400 && r.status < 500, `got ${r.status}`);
  const alive = await post('/scan', { html: '<div>still alive</div>' });
  check('T11 server still answers after bad body', alive.status === 200);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await sql`DELETE FROM funnel_pages WHERE funnel_id = ${FID}`;
await sql`DELETE FROM funnels WHERE id = ${FID}`;
server.close();
await sql.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
