// FUNNEL-SETTINGS render verification.
// Proves, by execution:
//   1. settings-gated emissions are ABSENT by default — pages render
//      byte-identical to the pre-change renderer (imported from the live main
//      worktree) for funnels with no/empty settings;
//   2. every emitted <script> on an enabled page PARSES (new Function);
//   3. hostile settings values (quotes, </script>, backslashes in the Maps
//      key; CSS/HTML breakouts in colors and font family) cannot escape
//      attributes, close the script tag, or break parsing.
//
// Run:  node server/tests/funnel-settings/render-settings.mjs
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const NEW = await import('../../src/services/funnelRender.js');

// Baseline: the renderer at this branch's merge-base with main (the untouched
// pre-change version), extracted via git so the comparison is exact regardless
// of what branch any sibling worktree currently has checked out.
const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = execFileSync('git', ['-C', repoDir, 'merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim();
const tmp = mkdtempSync(join(tmpdir(), 'fnl-baseline-'));
for (const f of ['funnelRender.js', 'trackingRuntime.js']) {
  writeFileSync(join(tmp, f), execFileSync('git', ['-C', repoDir, 'show', `${base}:server/src/services/${f}`], { encoding: 'utf8' }));
}
const OLD = await import(pathToFileURL(join(tmp, 'funnelRender.js')).href);
console.log(`baseline = funnelRender.js @ ${base.slice(0, 7)} (merge-base with main)`);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const page = {
  id: 'fpg_t1', slug: '/', title: 'Test page', status: 'published',
  blocks: [
    { type: 'heading', props: { text: 'Hello', level: 2 } },
    { type: 'html', props: { html: "<div class='ckt-field'><input name='address1'></div><div class='ckt-field ckt-phone'><span class='ckt-phone-prefix'>\u{1F1FA}\u{1F1F8} +1</span><input name='phone' type='tel'></div>" } },
  ],
  seo: {}, custom_css: '', custom_js: '', custom_html: '', head_html: '', body_end_html: '',
};
const funnelBare = { id: 'fnl_t1', slug: 'test', name: 'Test', status: 'published', seo: {} };
const pagesById = { fpg_t1: page };

// ── 1. byte-identity when settings are absent / empty / null ────────────────
{
  const oldHtml = OLD.renderPageHtml(page, funnelBare, pagesById);
  for (const [label, settings] of [['absent', undefined], ['empty {}', {}], ['null', null], ['non-object', 'nope']]) {
    const f = { ...funnelBare };
    if (settings !== undefined) f.settings = settings;
    const html = NEW.renderPageHtml(page, f, pagesById);
    check(`byte-identical to main renderer with settings ${label}`, html === oldHtml,
      `lengths old=${oldHtml.length} new=${html.length}`);
  }
  check('default page carries none of the new markers',
    !/lb-gmaps-autocomplete|lb-intl-phone|lb-brand-colors|lb-funnel-font/.test(oldHtml));
}

// ── 2. enabled settings emit, and every emitted <script> parses ─────────────
const fullSettings = {
  logo_url: 'https://cdn.example.com/logo.png',
  description: 'internal description',
  brand_colors: { primary: '#21a05f', secondary: '#161613' },
  fonts: { family: 'poppins' },
  checkout: { address_autocomplete: true, maps_api_key: 'AIzaSyTESTKEY-123_abc', intl_phone: true },
  custom_head_code: '<script>window.__fnl_head=1;</script>',
  custom_body_end_code: '<script>window.__fnl_body=1;</script>',
};
{
  const html = NEW.renderPageHtml(page, { ...funnelBare, settings: fullSettings }, pagesById);
  check('brand colors emitted', html.includes('<style id="lb-brand-colors">:root{--brand-primary:#21a05f;--brand-secondary:#161613}</style>'));
  check('font link + style emitted', html.includes('fonts.googleapis.com/css2?family=Poppins') && html.includes('<style id="lb-funnel-font">'));
  check('gmaps script emitted with the encoded key', html.includes('lb-gmaps-autocomplete') && html.includes('key=AIzaSyTESTKEY-123_abc&libraries=places'));
  check('intl phone script emitted', html.includes('lb-intl-phone') && html.includes('\u{1F1EE}\u{1F1F9}'));
  check('funnel head code emitted in <head>', html.indexOf('window.__fnl_head=1') !== -1 && html.indexOf('window.__fnl_head=1') < html.indexOf('</head>'));
  check('funnel body-end code emitted before </body>', html.indexOf('window.__fnl_body=1') > html.indexOf('<body>'));

  // Every <script> on the page must parse.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check('page has scripts to parse', scripts.length >= 4, `found ${scripts.length}`);
  let parseErrs = [];
  for (let i = 0; i < scripts.length; i++) {
    try { new Function(scripts[i]); } catch (e) { parseErrs.push(`#${i}: ${e.message}`); }
  }
  check('every emitted <script> parses via new Function', parseErrs.length === 0, parseErrs.join(' | '));

  // Emitted-code rule: the two NEW runtimes carry no backslash, backtick, ${ or regex literal.
  const gm = scripts.find((s) => s.includes('__fosPlacesInit')) || '';
  const ip = scripts.find((s) => s.includes('lb-intl-dial')) || '';
  check('new runtimes contain no backslash/backtick/${', ![gm, ip].some((s) => /[\\`]|\$\{/.test(s)));
}

// ── 3. hostile settings values cannot escape ────────────────────────────────
{
  const hostile = {
    brand_colors: { primary: '#111}</style><script>alert(1)</script>', secondary: 'red;background:url(evil)' },
    fonts: { family: "</style><script>alert(2)</script>" },
    checkout: {
      address_autocomplete: true,
      maps_api_key: "abc'</script><script>alert(3)</script>\\\"&x=1",
      intl_phone: true,
    },
  };
  const html = NEW.renderPageHtml(page, { ...funnelBare, settings: hostile }, pagesById);
  check('hostile colors emit NO brand style at all', !html.includes('lb-brand-colors') && !html.includes('alert(1)'));
  check('hostile font family emits NOTHING', !html.includes('lb-funnel-font') && !html.includes('alert(2)'));
  // The gmaps script content must contain no premature close tag and the
  // embedded key segment must be pure URL-encoded charset — no quote, no
  // backslash, no angle bracket can survive encodeURIComponent(+%27).
  check('hostile maps key cannot close the script tag', (() => {
    const m = html.match(/<script id="lb-gmaps-autocomplete">([\s\S]*?)<\/script>/);
    if (!m) return false;
    return !m[1].includes('</script') && !m[1].includes('<script');
  })());
  check('hostile maps key: emitted key segment is pure URL-encoded charset', (() => {
    const m = html.match(/maps\/api\/js\?key=([^&]*)&libraries/);
    if (!m) return false;
    return /^[A-Za-z0-9%()!*._~-]*$/.test(m[1]);
  })());
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parseErrs = [];
  for (let i = 0; i < scripts.length; i++) {
    try { new Function(scripts[i]); } catch (e) { parseErrs.push(`#${i}: ${e.message}`); }
  }
  check('hostile page: every <script> still parses', parseErrs.length === 0, parseErrs.join(' | '));
}

// ── 4. edge cases: toggles without key, truthy-but-not-true, key whitespace ─
{
  const noKey = NEW.renderPageHtml(page, { ...funnelBare, settings: { checkout: { address_autocomplete: true, intl_phone: false } } }, pagesById);
  check('autocomplete ON without a key emits nothing (fail-open)', !noKey.includes('lb-gmaps-autocomplete'));
  check('intl_phone false emits nothing', !noKey.includes('lb-intl-phone'));
  const truthy = NEW.renderPageHtml(page, { ...funnelBare, settings: { checkout: { address_autocomplete: 'yes', intl_phone: 1 } } }, pagesById);
  check('non-boolean truthy toggles emit nothing (strict === true)', !truthy.includes('lb-gmaps-autocomplete') && !truthy.includes('lb-intl-phone'));
  const ws = NEW.renderPageHtml(page, { ...funnelBare, settings: { checkout: { address_autocomplete: true, maps_api_key: '   ' } } }, pagesById);
  check('whitespace-only key emits nothing', !ws.includes('lb-gmaps-autocomplete'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
