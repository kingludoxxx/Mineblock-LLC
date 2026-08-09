// CUSTOM TRACKING RENDER INJECTION — integrator wiring verification.
// Proves funnelRender emits lb_tracking_custom_code's fields (joined onto the
// funnel row as `tracking_custom_code`) in the right places, in the right
// ORDER (after settings custom head/body code), through BOTH jsonb shapes,
// and that absence keeps the document byte-identical.
import { renderPageHtml } from '../../src/services/funnelRender.js';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; } else { fail += 1; console.error('FAIL', name); }
};

const PAGE = {
  id: 'fpg_test1', title: 'T', slug: '/',
  blocks: [{ id: 'blk_1', type: 'heading', props: { text: 'Hello' } }],
};
const BASE_FUNNEL = { id: 'fnl_test1', slug: 'trk-test', name: 'T', settings: {} };

const HEAD_SNIP = '<script data-trk="head-snippet">/* head pixel */</script>';
const BODY_SNIP = '<noscript data-trk="body-snippet"><img alt="" /></noscript>';

// 1. Absent column -> byte-identical to a funnel with no snippets.
{
  const a = renderPageHtml(PAGE, { ...BASE_FUNNEL }, {});
  const b = renderPageHtml(PAGE, { ...BASE_FUNNEL, tracking_custom_code: null }, {});
  ok(a === b, 'null column renders byte-identical');
  ok(!a.includes('data-trk='), 'no snippet leaks without a row');
}

// 2. Object shape (normal jsonb read) -> both fields emitted, right sections.
{
  const html = renderPageHtml(PAGE, {
    ...BASE_FUNNEL,
    tracking_custom_code: { head_html: HEAD_SNIP, body_html: BODY_SNIP },
  }, {});
  const headEnd = html.indexOf('</head>');
  const bodyEnd = html.indexOf('</body>');
  const headAt = html.indexOf('data-trk="head-snippet"');
  const bodyAt = html.indexOf('data-trk="body-snippet"');
  ok(headAt > -1 && headAt < headEnd, 'head snippet inside <head>');
  ok(bodyAt > headEnd && bodyAt < bodyEnd, 'body snippet before </body>');
}

// 3. Double-encoded string shape (jsonb string scalar) -> still emitted.
{
  const html = renderPageHtml(PAGE, {
    ...BASE_FUNNEL,
    tracking_custom_code: JSON.stringify({ head_html: HEAD_SNIP, body_html: '' }),
  }, {});
  ok(html.includes('data-trk="head-snippet"'), 'string-shape jsonb still emits');
  ok(!html.includes('data-trk="body-snippet"'), 'empty body field emits nothing');
}

// 4. ORDER: tracking head code emits AFTER settings.custom_head_code, so a
//    consent manager in Advanced -> Scripts initializes first.
{
  const html = renderPageHtml(PAGE, {
    ...BASE_FUNNEL,
    settings: { custom_head_code: '<script data-trk="consent-mgr"></script>' },
    tracking_custom_code: { head_html: HEAD_SNIP, body_html: '' },
  }, {});
  const consentAt = html.indexOf('data-trk="consent-mgr"');
  const pixelAt = html.indexOf('data-trk="head-snippet"');
  ok(consentAt > -1 && pixelAt > -1 && consentAt < pixelAt,
    'settings head code precedes tracking head snippet');
}

// 5. Garbage shapes degrade to nothing, never throw.
{
  for (const junk of ['not json', 42, [], { head_html: 7, body_html: {} }]) {
    let html = '';
    try {
      html = renderPageHtml(PAGE, { ...BASE_FUNNEL, tracking_custom_code: junk }, {});
    } catch (err) {
      ok(false, `junk shape threw: ${err.message}`);
      continue;
    }
    ok(!html.includes('data-trk='), `junk shape (${typeof junk}) emits nothing`);
  }
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
