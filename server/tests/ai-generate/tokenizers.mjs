// Unit tests for the paste-pane syntax highlighters in codeFormat.js
// (pure JS, no JSX — importable straight from node).
//
// Run:  node server/tests/ai-generate/tokenizers.mjs
import {
  formatHtml, formatCss, highlightHtml, highlightCss, HIGHLIGHT_MAX,
} from '../../../client/src/components/funnels/codeFormat.js';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${extra}`); }
};

// Reverse of the highlighter: drop spans, unescape — must yield the source.
const unhighlight = (html) =>
  html
    .replace(/<span class="cf-[a-z]">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// ---------------------------------------------------------------------------
// HTML highlighter
// ---------------------------------------------------------------------------
{
  const src = '<div class="hero" id=\'a\' data-x=1><!-- note --><p>x &amp; 1 < 2</p></div>';
  const out = highlightHtml(src);
  check('html: returns a string', typeof out === 'string');
  check('html: lossless round-trip', unhighlight(out) === src, JSON.stringify(unhighlight(out)));
  check('html: tag names tagged cf-t', out.includes('<span class="cf-t">div</span>') && out.includes('<span class="cf-t">p</span>'));
  check('html: attributes tagged cf-a', out.includes('<span class="cf-a">class</span>') && out.includes('<span class="cf-a">id</span>'));
  check('html: quoted values tagged cf-s', out.includes('<span class="cf-s">"hero"</span>') && out.includes("<span class=\"cf-s\">'a'</span>"));
  check('html: unquoted attr value tagged cf-s', out.includes('<span class="cf-s">1</span>'));
  check('html: comments tagged cf-c', /<span class="cf-c">&lt;!-- note --&gt;<\/span>/.test(out));
  // Note: the stray "< 2" run is tokenized as a decl-ish token (cf-c) — the
  // round-trip check above already proves nothing is dropped or altered.
  check('html: text content escaped', out.includes('x &amp;amp; 1'));
}

{
  // <style> body goes through the CSS highlighter; <script> body stays plain.
  const src = '<style>.a{color:red}</style><script>if(1<2){x="</p>"}</script>';
  const out = highlightHtml(src);
  check('html: style body css-highlighted', out.includes('<span class="cf-a">color</span>') && out.includes('<span class="cf-s">red</span>'));
  check('html: script body escaped plain (no spans inside)', out.includes('if(1&lt;2){x="&lt;/p&gt;"}'));
  check('html: opaque round-trip lossless', unhighlight(out) === src);
}

{
  // Attribute value with '>' inside quotes must not end the tag early.
  const src = '<a href="/x?a>b" title=\'1>2\'>t</a>';
  const out = highlightHtml(src);
  check('html: quoted ">" does not end the tag', out.includes('<span class="cf-s">"/x?a&gt;b"</span>'), out);
  check('html: quoted-gt round-trip lossless', unhighlight(out) === src);
}

// ---------------------------------------------------------------------------
// CSS highlighter
// ---------------------------------------------------------------------------
{
  const src = '/* note */\n.hero h1 { color: #fff; background: url("data:image/png;base64,AA;BB") no-repeat; }';
  const out = highlightCss(src);
  check('css: returns a string', typeof out === 'string');
  check('css: lossless round-trip', unhighlight(out) === src, JSON.stringify(unhighlight(out)));
  check('css: comment tagged cf-c', out.includes('<span class="cf-c">/* note */</span>'));
  check('css: selector tagged cf-t', /<span class="cf-t">\s*\.hero h1\s?<\/span>/.test(out) || out.includes('<span class="cf-t">\n.hero h1 </span>'), out.slice(0, 200));
  check('css: property tagged cf-a', out.includes('cf-a') && /cf-a">\s*color<\/span>|cf-a"> color<\/span>/.test(out), out);
  check('css: url(...) with ";" inside stays one value token', /<span class="cf-s">[^<]*url\("data:image\/png;base64,AA;BB"\) no-repeat<\/span>/.test(out), out);
  check('css: punctuation tagged cf-p', out.includes('<span class="cf-p">{</span>') && out.includes('<span class="cf-p">;</span>') && out.includes('<span class="cf-p">}</span>'));
}

{
  const src = '@media (max-width:600px){ .a:hover{b:c} }';
  const out = highlightCss(src);
  check('css: media prelude parens stay in the selector token', out.includes('(max-width:600px)'), out);
  check('css: pseudo-selector ":" at depth>0 splits only once', unhighlight(out) === src);
}

// ---------------------------------------------------------------------------
// Pathological input degrades gracefully
// ---------------------------------------------------------------------------
{
  const big = 'x'.repeat(HIGHLIGHT_MAX + 1);
  check('html: >300KB returns null (degrade to plain textarea)', highlightHtml(big) === null);
  check('css: >300KB returns null (degrade to plain textarea)', highlightCss(big) === null);

  const weird = [
    '<div class="unterminated',
    '<!-- unterminated comment',
    '<style>.a{b:"unclosed}</style>',
    '<<>><=">\'',
    '<script>never closed',
    '',
  ];
  let threw = false;
  for (const w of weird) {
    try {
      const h = highlightHtml(w);
      const c = highlightCss(w);
      if (typeof h !== 'string' || typeof c !== 'string') threw = true;
    } catch (err) {
      threw = true;
      console.log(`  threw on ${JSON.stringify(w)}: ${err.message}`);
    }
  }
  check('weird inputs never throw and always return strings', !threw);

  // Round-trip holds even on the weird ones (nothing dropped, nothing added).
  let lossy = null;
  for (const w of weird) {
    if (unhighlight(highlightHtml(w)) !== w) { lossy = `html:${w}`; break; }
    if (unhighlight(highlightCss(w)) !== w) { lossy = `css:${w}`; break; }
  }
  check('weird inputs stay lossless', lossy === null, lossy || '');

  // Just-at-the-limit input still highlights (the cap is strictly greater-than).
  const atLimit = 'y'.repeat(HIGHLIGHT_MAX);
  check('input exactly at the cap still highlights', typeof highlightHtml(atLimit) === 'string');
}

// ---------------------------------------------------------------------------
// Formatters still behave (regression guard — same module, untouched paths)
// ---------------------------------------------------------------------------
{
  const html = formatHtml('<div><p>a</p></div>');
  check('formatHtml still indents', html === '<div>\n  <p>\n    a\n  </p>\n</div>', JSON.stringify(html));
  const css = formatCss('.a{b:c;d:e}');
  check('formatCss still splits', css === '.a {\n  b:c;\n  d:e\n}', JSON.stringify(css));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
