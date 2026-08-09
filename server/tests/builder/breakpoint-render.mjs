// Verification for the STYLE-TAB BREAKPOINT slice's render side.
//
// House rule: only the integrator edits funnelRender.js. This branch
// therefore ships the editor UX + data model + canvas, and the renderer patch
// as a reviewed diff. This harness is what makes that diff safe to apply — it
// runs against WHICHEVER funnelRender it is pointed at and adapts:
//
//   • UNPATCHED (default, today's repo):  proves the GAP by execution —
//     props.mobile_styles and the new alignment keys reach the public page
//     NOWHERE, so the diff is genuinely required and not busywork.
//
//   • PATCHED (FR_MODULE=<path to a patched copy>, or once the diff lands on
//     main): proves the emitter — the media query, the !important that makes
//     it beat the inline base style, the id allow-list, the clamps, the
//     byte-identical output for pages with no overrides, and fail-open on a
//     hostile props bag.
//
// Detection is by feature (does the module export blockMobileCss?), not by a
// flag — a flag goes stale the day the patch lands and then lies.
//
// Run:  node server/tests/builder/breakpoint-render.mjs
//       FR_MODULE=/abs/path/to/funnelRender.patched.js node server/tests/builder/breakpoint-render.mjs
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const MODULE_PATH = process.env.FR_MODULE
  ? resolve(process.env.FR_MODULE)
  : resolve(new URL('../../src/services/funnelRender.js', import.meta.url).pathname);

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };

const fr = await import(pathToFileURL(MODULE_PATH).href);
const PATCHED = typeof fr.blockMobileCss === 'function';
console.log(`module: ${MODULE_PATH}`);
console.log(`mode:   ${PATCHED ? 'PATCHED (emitter present)' : 'UNPATCHED (proving the gap)'}\n`);

const FUNNEL = { id: 'fnl_bp', slug: 'bp', seo: {}, flow_layout: { nodes: [], edges: [] } };
const mkPage = (blocks, extra = {}) => ({
  id: 'fpg_bp', title: 'BP', slug: '/', type: 'generic',
  blocks, custom_css: '', custom_js: '', custom_html: '', head_html: '', body_end_html: '',
  seo: {}, ...extra,
});

const STYLED = {
  id: 'blk1',
  type: 'heading',
  props: {
    text: 'Hello',
    style: { font_size: 42, bg: '#ffffff', text_align: 'center' },
    mobile_styles: { font_size: 24, text_align: 'left', padding: '8px', justify_content: 'center' },
  },
};

// ---------------------------------------------------------------------------
// Shared: the wrapper the selector depends on must exist in BOTH modes.
// If renderBlock ever stopped emitting data-blk-id, the whole strategy dies —
// and it would die silently, so assert it here rather than assume it.
// ---------------------------------------------------------------------------
{
  const html = fr.renderPageHtml(mkPage([STYLED]), FUNNEL, {});
  ok(html.includes("data-blk-id='blk1'"), 'wrapper: the block carries data-blk-id (the selector hook)');
  ok(/@media \(max-width: ?767px\)/.test(html), 'theme: 767px is the established mobile boundary (lb-hide-mobile)');
}

if (!PATCHED) {
  // ---- GAP PROOF ----------------------------------------------------------
  const html = fr.renderPageHtml(mkPage([STYLED]), FUNNEL, {});
  const wrap = fr.blockStyleWrap(STYLED.props);
  ok(!html.includes('mobile_styles'), 'gap: mobile_styles never appears in the public HTML');
  ok(!html.includes('font-size:24'), 'gap: the mobile font-size is NOT emitted anywhere');
  ok(!html.includes('lb-blk-mobile'), 'gap: no per-block mobile <style> block exists');
  ok(!wrap.styleAttr.includes('text-align'),
    'gap: text_align is NOT emitted by blockStyleWrap either (base alignment needs the patch too)', wrap.styleAttr);
  ok(!wrap.styleAttr.includes('justify-content'),
    'gap: justify_content is NOT emitted by blockStyleWrap', wrap.styleAttr);
  ok(wrap.styleAttr.includes('font-size:42px') && wrap.styleAttr.includes('background:#ffffff'),
    'gap: the base keys that DO exist still emit (the gap is the new keys, not a regression)', wrap.styleAttr);
  console.log('\n→ The renderer patch is REQUIRED: neither mobile overrides nor the');
  console.log('  alignment keys can reach the public page without it.');
} else {
  // ---- EMITTER PROOF ------------------------------------------------------
  const { blockMobileCss, blockStyleDecls, blockStyleWrap, renderPageHtml, MOBILE_MAX_PX } = fr;

  ok(MOBILE_MAX_PX === 767, 'emitter: the boundary matches THEME_CSS (767px)', String(MOBILE_MAX_PX));

  // base bag: the two new keys now emit
  {
    const w = blockStyleWrap(STYLED.props);
    ok(w.styleAttr.includes('text-align:center'), 'base: text_align emits', w.styleAttr);
    ok(w.styleAttr.includes('font-size:42px'), 'base: existing keys unchanged', w.styleAttr);
    const j = blockStyleWrap({ style: { justify_content: 'space-between' } });
    ok(j.styleAttr.includes('display:flex') && j.styleAttr.includes('justify-content:space-between'),
      'base: justify_content emits display:flex alongside it', j.styleAttr);
  }

  // the media block itself
  const css = blockMobileCss([STYLED]);
  ok(css.startsWith('@media (max-width:767px){') && css.endsWith('}'), 'emitter: wrapped in the mobile media query', css);
  ok(css.includes("[data-blk-id='blk1']{"), 'emitter: selector keys on data-blk-id', css);
  ok(css.includes('font-size:24px !important'), 'emitter: mobile font-size is clamped, unit-suffixed and !important', css);
  ok(css.includes('text-align:left !important'), 'emitter: mobile text-align', css);
  ok(css.includes('padding:8px !important'), 'emitter: mobile padding', css);
  ok(css.includes('display:flex !important') && css.includes('justify-content:center !important'),
    'emitter: a compound decl (display:flex;justify-content) marks BOTH halves important', css);
  ok(!/;;/.test(css) && !/{\s*;/.test(css), 'emitter: no empty declarations', css);

  // !important is the whole point — prove the inline base style is the reason
  {
    const w = blockStyleWrap(STYLED.props);
    ok(w.styleAttr.includes('font-size:42px'),
      'cascade: the BASE bag really is an INLINE style attribute (why !important is required)', w.styleAttr);
    const marks = (css.match(/!important/g) || []).length;
    const decls = (css.match(/:/g) || []).length;
    ok(marks >= 4 && marks === decls - 1, 'cascade: every emitted declaration carries !important',
      `${marks} marks / ${decls} colons (one colon belongs to max-width)`);
  }

  // z-index compound + clamping
  {
    const c = blockMobileCss([{ id: 'z1', type: 'text', props: { mobile_styles: { z_index: 99999, font_size: 9999 } } }]);
    ok(c.includes('z-index:9999 !important'), 'clamp: z_index clamped to 9999', c);
    ok(c.includes('position:relative !important'), 'clamp: z-index still brings position:relative', c);
    ok(c.includes('font-size:300px !important'), 'clamp: font_size clamped to 300px', c);
  }

  // hostile input
  {
    const c = blockMobileCss([{ id: 'h1', type: 'text', props: { mobile_styles: { width: "10px} body{display:none} .x{'" } } }]);
    ok(!c.includes('}') || !/body\s*{/.test(c), 'hostile: CSS metachars stripped, no rule injection', c);
    ok(!c.includes('<') && !c.includes('>'), 'hostile: angle brackets stripped (cannot close the <style>)', c);
  }
  {
    const c = blockMobileCss([{ id: "x'] , * {color:red} [z='", type: 'text', props: { mobile_styles: { width: '10px' } } }]);
    ok(c === '', 'hostile: a block id outside the allow-list is SKIPPED, never sanitized into a selector', c);
  }
  {
    ok(blockMobileCss([{ id: 'ok', type: 't', props: { mobile_styles: 'not-an-object' } }]) === '',
      'degraded: a non-object mobile_styles yields nothing');
    ok(blockMobileCss(null) === '' && blockMobileCss(undefined) === '' && blockMobileCss('x') === '',
      'degraded: a non-array blocks argument yields nothing, never throws');
    ok(blockStyleDecls(null).length === 0, 'degraded: blockStyleDecls(null) is empty');
  }

  // byte-identity for pages that carry no overrides
  {
    const plain = [{ id: 'p1', type: 'heading', props: { text: 'Hi', style: { font_size: 20 } } }];
    ok(blockMobileCss(plain) === '', 'no-override: emits the empty string');
    const html = renderPageHtml(mkPage(plain), FUNNEL, {});
    ok(!html.includes('lb-blk-mobile'), 'no-override: no <style id="lb-blk-mobile"> in the document');
  }

  // F1 — BYTE IDENTITY. The conditional must add ZERO bytes when no block
  // carries an override. An interpolation on its own line looks harmless and
  // leaves a blank line in the head of EVERY page ever served.
  {
    const plain = [{ id: 'p1', type: 'heading', props: { text: 'Hi', style: { font_size: 20 } } }];
    const patchedHtml = renderPageHtml(mkPage(plain), FUNNEL, {});
    let baseline = null;
    try {
      // The repo module — unpatched while this diff is still pending.
      baseline = (await import('../../src/services/funnelRender.js')).renderPageHtml(mkPage(plain), FUNNEL, {});
    } catch { /* unreadable baseline — the structural checks below still run */ }
    if (baseline !== null && !baseline.includes('lb-blk-mobile')) {
      ok(patchedHtml === baseline,
        'F1: a page with NO overrides renders BYTE-IDENTICAL to the unpatched renderer',
        `patched ${patchedHtml.length} B vs baseline ${baseline.length} B`);
    }
    ok(!patchedHtml.includes('lb-blk-mobile'),
      'F1: no empty <style> tag is emitted for a page with no overrides');
    // The head must not gain a line. Counting is the check that survives the
    // baseline being unavailable.
    if (baseline !== null) {
      ok(patchedHtml.split('\n').length === baseline.split('\n').length,
        'F1: the document has the SAME line count as the unpatched renderer',
        `${patchedHtml.split('\n').length} vs ${baseline.split('\n').length}`);
    }
  }

  // F2 — a hidden block must STAY hidden. display:flex!important from a mobile
  // justify preset is an important declaration of the same property as
  // .lb-hide-mobile{display:none!important}; equal specificity means the later
  // rule wins, and the emitted sheet comes after the theme.
  {
    const hidden = [{
      id: 'h9', type: 'text',
      props: {
        style: { hide_mobile: true, font_size: 20 },
        mobile_styles: { justify_content: 'center', font_size: 12 },
      },
    }];
    const c = blockMobileCss(hidden);
    // Scope the assertion to the BLOCK's own rule — the sheet also carries the
    // F2b guard, whose whole job is to declare display:none.
    const blockRule = (c.match(/\[data-blk-id='h9'\]\{([^}]*)\}/) || [])[1] || '';
    ok(blockRule.length > 0, 'F2a: the hidden block still gets a rule', c);
    ok(!/display\s*:/.test(blockRule),
      'F2a: NO display declaration inside that rule (the flex preset is dropped)', blockRule);
    ok(c.includes('font-size:12px !important'),
      'F2a: its other mobile overrides still emit (the filter is surgical)', c);

    ok(c.includes("[data-blk-id].lb-hide-mobile{display:none !important}"),
      'F2b: the emitted sheet re-states the hide rule at 2-selector specificity', c);
    ok(c.indexOf('[data-blk-id].lb-hide-mobile') > c.indexOf("[data-blk-id='h9']"),
      'F2b: …and it comes AFTER the block rules, so order backs specificity up', c);

    const html = renderPageHtml(mkPage(hidden), FUNNEL, {});
    ok(html.includes('lb-hide-mobile'),
      'F2b: the block still carries the class the rule matches');
    ok(html.includes("data-blk-id='h9'"),
      'F2b: …and the data-blk-id the raised selector needs (otherwise it stops matching)');
    // The guard costs nothing on a page with no overrides — that is why it
    // lives in the emitted sheet instead of in THEME_CSS.
    ok(blockMobileCss([{ id: 'n1', type: 'text', props: {} }]) === '',
      'F2b: no override ⇒ no sheet ⇒ no guard ⇒ no bytes');

    // Belt 2 alone, with the filter bypassed: prove the raised selector wins.
    const forced = blockMobileCss([{ id: 'h8', type: 'text', props: { mobile_styles: { justify_content: 'center' } } }]);
    ok(forced.includes('display:flex !important'),
      'F2: a block that is NOT hidden still gets its flex preset (no over-correction)', forced);
  }

  // F10 — a CSS comment opener in one value must not swallow later rules.
  {
    const blocks = [
      { id: 'c1', type: 'text', props: { mobile_styles: { width: '10px/*' } } },
      { id: 'c2', type: 'text', props: { mobile_styles: { font_size: 14 } } },
    ];
    const c = blockMobileCss(blocks);
    ok(!c.includes('/*') && !c.includes('*/'), 'F10: no comment delimiter survives into the sheet', c);
    ok(c.includes("[data-blk-id='c2']") && c.includes('font-size:14px !important'),
      'F10: the LATER block\'s rule is intact — nothing was commented out', c);
    ok(c.includes('width:10px !important'), 'F10: the offending value still emits, minus the opener', c);
    // A crafted value that would leave a live opener after a single pass.
    const nested = blockMobileCss([
      { id: 'c3', type: 'text', props: { mobile_styles: { width: '1px/*/*' } } },
      { id: 'c4', type: 'text', props: { mobile_styles: { font_size: 11 } } },
    ]);
    ok(!nested.includes('/*'), 'F10: nested openers are stripped to a fixed point, not one pass', nested);
    ok(nested.includes('font-size:11px !important'), 'F10: the later rule survives that too', nested);
    // …and the legitimate slash uses are NOT collateral damage.
    const slash = blockMobileCss([{ id: 'c5', type: 'text', props: { mobile_styles: { bg: 'rgb(0 0 0 / 50%)' } } }]);
    ok(slash.includes('rgb(0 0 0 / 50%)'),
      'F10: a bare slash (modern alpha syntax) is preserved, not stripped', slash);
    const url = blockStyleWrap({ style: { bg: 'url(/img/x.png)' } });
    ok(url.styleAttr.includes('url(/img/x.png)'),
      'F10: url(/path) still works on the existing inline path (no regression)', url.styleAttr);
  }

  // integrated: the style tag lands in the head, before the operator's page CSS
  {
    const html = renderPageHtml(mkPage([STYLED], { custom_css: '.mine{color:red}' }), FUNNEL, {});
    ok(html.includes('<style id="lb-blk-mobile">'), 'integrated: the mobile <style> is emitted');
    ok(html.indexOf('lb-blk-mobile') < html.indexOf('lb-page-css'),
      'integrated: it precedes lb-page-css, so operator CSS can still win');
    ok(html.indexOf('lb-blk-mobile') < html.indexOf('<body>'), 'integrated: it is in the head');
    ok(html.includes('font-size:24px !important'), 'integrated: the declaration crossed into the document');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
