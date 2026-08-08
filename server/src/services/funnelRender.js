// Funnel Builder — slice 2: public page rendering.
//
// Port of the reference render pipeline (funnel-os
// backend/app/services/listicle_builders_service.py — render_page_html /
// _render_block_inner) into Node. Emits a full HTML document from
// page.blocks + the page's escape hatches.
//
// Postures carried over from the reference (docs/DECISIONS.md):
//  • EVERY block renders fail-open: a bad block degrades to an HTML comment
//    stub, never a page-wide 500. Serving fails open; only money fails closed.
//  • Raw blocks (custom_html / html / embed) and operator HTML props
//    (section/row/text html) emit VERBATIM — deliberately NOT sanitized.
//    This is an internal authoring tool: sanitizing strips <script>/on*=
//    handlers that cloned pages and quiz engines depend on, which publishes
//    silently-BLANK pages — the worst possible failure mode. Do not "fix"
//    this by adding a sanitizer.
//  • User TEXT in structured blocks (heading text, list items, table cells,
//    FAQ q/a, ranking names…) is HTML-escaped.
//  • Commerce/quiz blocks (product, order bump, shipping, form, quiz_embed,
//    and the other gateway checkouts — stripe/nmi/express) are NOT ported yet —
//    they render an inert, clearly-labelled placeholder so pages containing
//    them still render.
//  • CHECKOUT-JOIN slice: `whop_checkout` + `order_summary` are LIVE. They
//    render a real, functional Whop embedded checkout that drives the already-
//    built public money path (routes/checkoutPublic.js): create-session
//    (server re-prices) → whop/create-session (embed config) → js.whop.com
//    loader mounts the embed. See the whop_checkout case + checkoutRuntime-
//    Script below for the full contract + posture.

const isPlainObject = (v) =>
  v != null && typeof v === 'object' && !Array.isArray(v);

// html_lib.escape(quote=True) equivalent — attrs below use single quotes,
// so ' must be escaped too.
export const escapeHtml = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const esc = escapeHtml;

// #4: href sink guard. Operator-authored hrefs are served on the public,
// unauthenticated host — a `javascript:`/`data:`/`vbscript:` URL is click-to-XSS.
// Allow only http(s)/mailto/tel/relative; anything else collapses to '#'.
// Returns an HTML-attribute-escaped value.
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:)/i;
export const safeHref = (v) => {
  const raw = String(v ?? '').trim();
  if (!raw) return '#';
  // A scheme is present only if a ':' appears before any '/', '?' or '#'.
  const firstColon = raw.indexOf(':');
  const firstSlash = raw.search(/[/?#]/);
  const hasScheme = firstColon !== -1 && (firstSlash === -1 || firstColon < firstSlash);
  if (hasScheme && !SAFE_URL_SCHEME.test(raw)) return '#';
  return esc(raw);
};

// #5: url() inside a style attribute is a different context than HTML — the
// HTML parser decodes entities before the CSS parser runs, so HTML-escaping
// alone lets a quote/paren re-appear at the CSS layer (injection/exfil).
// Percent-encode the CSS-breaking characters and allow only safe schemes.
export const safeCssUrl = (v) => {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  const firstColon = raw.indexOf(':');
  const firstSlash = raw.search(/[/?#]/);
  const hasScheme = firstColon !== -1 && (firstSlash === -1 || firstColon < firstSlash);
  if (hasScheme && !/^https?:/i.test(raw)) return '';
  return raw.replace(/[\\'"()\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
};

const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// Block types deferred to later slices — placeholder, never a 500.
// NOTE: `whop_checkout` and `order_summary` are NOT here — they are LIVE
// (see the switch below). The other gateway checkouts stay placeholders this
// pass (they need their own gateway-specific mount; this slice ships whop end
// to end, which is the gateway the money path is wired for).
const PLACEHOLDER_TYPES = new Set([
  'stripe_checkout',
  'nmi_checkout',
  'express_checkout',
  'product',
  'order_bump',
  'checkout_template',
  'shipping_method',
  'form',
  'quiz_embed',
]);

// Commerce block types that require the checkout runtime + page context
// (funnel_id / page_id) to be emitted into the document. Presence of any of
// these on the page turns on checkoutRuntimeScript(); a page without them is
// byte-for-byte unchanged from before this slice.
const COMMERCE_RUNTIME_TYPES = new Set(['whop_checkout', 'order_summary']);

// ---------------------------------------------------------------------------
// whop_checkout block config (operator-authored, set as block.props on the
// canvas page editor — no new UI needed; it accepts blocks JSON directly).
//
//   props.variant_id : "51234567890"    (a Shopify variant id — numeric id or
//                                         gid://…/ProductVariant/<id>)
//   props.quantity   : 1                 (optional, default 1, clamped >= 1)
//   — OR, for a multi-line cart —
//   props.line_items : [ { variant_id, quantity }, ... ]
//   props.button_text: "Complete order" (optional; a fallback link label — the
//                                         Whop embed renders its own pay button)
//
// CRITICAL: the block config carries NO price. Prices are resolved SERVER-SIDE
// by create-session against Shopify; the page never sends, and cannot
// influence, an amount. A `price` on props is IGNORED (never emitted).
// ---------------------------------------------------------------------------
function readCheckoutLineItems(p) {
  const out = [];
  if (Array.isArray(p.line_items)) {
    for (const li of p.line_items) {
      if (!isPlainObject(li)) continue;
      const vid = li.variant_id != null ? String(li.variant_id).trim() : '';
      if (!vid) continue;
      out.push({ variant_id: vid, quantity: Math.max(1, toInt(li.quantity, 1)) });
    }
  }
  if (!out.length) {
    const vid = p.variant_id != null ? String(p.variant_id).trim() : '';
    if (vid) out.push({ variant_id: vid, quantity: Math.max(1, toInt(p.quantity, 1)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-block renderers (port of _render_block_inner)
// ---------------------------------------------------------------------------

function renderBlockInner(block) {
  const t = (block || {}).type;
  // isinstance guard, NOT a default: a block persisted as {type, props: null}
  // (or props as any non-object JSON — write validation can be bypassed by
  // direct inserts / import paths) must degrade to a comment stub, never
  // throw on every serve of the published page.
  const rawProps = (block || {}).props;
  if (!isPlainObject(rawProps)) {
    return `<!-- block degraded: props is not an object (type=${esc(String(t))}) -->`;
  }
  const p = rawProps;

  if (PLACEHOLDER_TYPES.has(t)) {
    return (
      `<div class='lb-placeholder' data-placeholder-type='${esc(t)}' ` +
      `style='border:1px dashed #cbd5e1;border-radius:10px;padding:24px;` +
      `text-align:center;color:#6b7280;font:500 14px/1.5 system-ui,sans-serif;` +
      `background:#fafafa;margin:16px 0'>` +
      `${esc(t)} block — not rendered in this slice</div>`
    );
  }

  switch (t) {
    case 'custom_html': {
      // Operator-authored raw HTML (+ optional CSS) — verbatim (see header).
      const html = p.html || '';
      const css = String(p.css || '').trim();
      const style = css ? `<style>${css}</style>` : '';
      return `<div class='lb-customhtml'>${style}${html}</div>`;
    }
    case 'whop_checkout': {
      // Real, functional Whop embedded checkout mount. Emits ONLY structure +
      // a JSON config of {variant_id, quantity} line items — the driving
      // runtime (checkoutRuntimeScript, emitted once at page level) does the
      // work: create-session (server re-prices) → whop/create-session (embed
      // config, returns a ch_… session id) → the official js.whop.com loader
      // mounts the embed on [data-fos-whop-mount] via data-whop-checkout-
      // session. The Whop embed renders its OWN pay button; the fallback <a>
      // (populated with the session's purchase_url) is the graceful degrade if
      // the embed script can't load. The config carries NO price.
      const lineItems = readCheckoutLineItems(p);
      // jsonForScript() escapes '<' so a variant id containing '</script>' can
      // never break out of the application/json island.
      const cfgJson = jsonForScript({ line_items: lineItems });
      const fbText = esc(String(p.button_text || 'Complete order'));
      const configured = lineItems.length > 0;
      const errInit = configured ? '' : 'This checkout has no product configured yet.';
      return (
        `<div class='lb-checkout fos-checkout' data-fos-checkout data-fos-gateway='whop'>` +
        `<div class='lb-checkout-summary fos-order-summary' data-fos-order-summary>` +
        `<div class='fos-os-empty'>Preparing your order…</div></div>` +
        `<div class='lb-whop-mount' data-fos-whop-mount></div>` +
        `<div class='lb-checkout-error' data-fos-error${configured ? ' hidden' : ''}>` +
        `${esc(errInit)}</div>` +
        `<a class='lb-btn lb-checkout-fallback' data-fos-fallback rel='noopener noreferrer' ` +
        `target='_blank' href='#' hidden>${fbText}</a>` +
        `<script type='application/json' class='fos-checkout-cfg'>${cfgJson}</script>` +
        `</div>`
      );
    }
    case 'order_summary': {
      // Renders the line items + total of the created checkout session. The
      // data comes from the create-session response the checkout runtime
      // already holds (window.__fos_checkout.session) — the runtime fills
      // EVERY [data-fos-order-summary] on the page once the session exists.
      const title = esc(String(p.title || 'Order summary'));
      return (
        `<section class='lb-order-summary'>` +
        `<h3 class='lb-order-summary-title'>${title}</h3>` +
        `<div class='fos-order-summary' data-fos-order-summary>` +
        `<div class='fos-os-empty'>Your order will appear here.</div>` +
        `</div></section>`
      );
    }
    case 'section': {
      const inner = p.html || '';
      const pad = esc(p.padding || '48px 24px');
      const bg = p.background || '';
      const maxw = esc(p.max_width || '1100px');
      const bgCss = bg ? `background:${esc(bg)};` : '';
      return (
        `<section class='lb-sectionblk' style='padding:${pad};${bgCss}'>` +
        `<div style='max-width:${maxw};margin:0 auto'>${inner}</div>` +
        `</section>`
      );
    }
    case 'row': {
      const cols = Array.isArray(p.columns) ? p.columns : [];
      const gap = toInt(p.gap, 16);
      const align = esc(p.align || 'stretch');
      const colHtml = cols
        .map(
          (c) =>
            `<div class='lb-colblk' style='flex:1 1 220px;min-width:0'>` +
            `${(isPlainObject(c) && c.html) || ''}</div>`
        )
        .join('');
      return (
        `<div class='lb-rowblk' style='display:flex;flex-wrap:wrap;` +
        `gap:${gap}px;align-items:${align}'>${colHtml}</div>`
      );
    }
    case 'hero': {
      const bg = p.image_url || '';
      const bgStyle = bg ? ` style="background-image:url('${safeCssUrl(bg)}')"` : '';
      const ctaHref = safeHref(p.cta_href || '#');
      return (
        `<section class='lb-hero'${bgStyle}>` +
        `<div class='lb-container'>` +
        `<h1 data-el='headline'>${esc(p.headline || '')}</h1>` +
        `<p data-el='subheadline'>${esc(p.subheadline || '')}</p>` +
        `<a class='lb-btn' data-el='cta' href='${ctaHref}'>${esc(p.cta_text || 'Learn more')}</a>` +
        `</div></section>`
      );
    }
    case 'heading': {
      const level = Math.max(1, Math.min(toInt(p.level, 2), 6));
      return `<h${level} class='lb-heading' data-el='text'>${esc(p.text || '')}</h${level}>`;
    }
    case 'text': {
      // Operator-supplied HTML wins for rich paragraphs; plain text is escaped.
      const body = p.html || esc(p.text || '');
      return `<div class='lb-text'>${body}</div>`;
    }
    case 'image': {
      const src = esc(p.src || '');
      const alt = esc(p.alt || '');
      return `<figure class='lb-image'><img data-el='image' src='${src}' alt='${alt}' loading='lazy'/></figure>`;
    }
    case 'video': {
      const src = esc(p.src || '');
      return `<div class='lb-video'><video data-el='video' src='${src}' controls></video></div>`;
    }
    case 'button': {
      const inter = isPlainObject((block || {}).interaction)
        ? block.interaction
        : {};
      const href = safeHref(String(inter.href || p.href || '#'));
      let extra = '';
      for (const attr of ['action', 'coupon', 'speed', 'target', 'title']) {
        const v = String(inter[attr] || '').trim();
        if (v) extra += ` ${attr}='${esc(v)}'`;
      }
      const bid = esc((block || {}).id || '');
      return (
        `<div class='lb-button-wrap'>` +
        `<a class='lb-btn' data-el='cta' data-lb-btn='${bid}' href='${href}'${extra}>` +
        `${esc(p.text || 'Click')}</a></div>`
      );
    }
    case 'divider':
      return "<hr class='lb-divider'/>";
    case 'spacer': {
      const h = toInt(p.height, 32);
      return `<div class='lb-spacer' style='height:${h}px'></div>`;
    }
    case 'list': {
      const items = Array.isArray(p.items) ? p.items : [];
      const lis = items.map((i) => `<li>${esc(String(i))}</li>`).join('');
      return `<ul class='lb-list'>${lis}</ul>`;
    }
    case 'checklist': {
      const items = Array.isArray(p.items) ? p.items : [];
      const lis = items
        .map(
          (i) =>
            `<li><span class='lb-check' data-el='check'>✓</span> ` +
            `<span data-el='item'>${esc(String(i))}</span></li>`
        )
        .join('');
      return `<ul class='lb-checklist'>${lis}</ul>`;
    }
    case 'ranking': {
      const items = (Array.isArray(p.items) ? p.items : []).filter(isPlainObject);
      const cards = items
        .map(
          (it) =>
            `<article class='lb-ranking-item' id='${esc(it.rank ?? '')}'>` +
            `<span class='lb-rank-no'>#${esc(it.rank ?? '')}</span>` +
            `<div class='lb-rank-body'>` +
            `<h3 data-el='item_name'>${esc(it.name || '')}</h3>` +
            `<p class='lb-rank-summary' data-el='item_summary'>${esc(it.summary || '')}</p>` +
            `<span class='lb-rank-score' data-el='item_score'>${esc(String(it.score ?? ''))}/10</span>` +
            `</div></article>`
        )
        .join('');
      return (
        `<section class='lb-ranking' id='top-picks'>` +
        `<div class='lb-container'>` +
        `<h2 data-el='title'>${esc(p.title || 'Top Picks')}</h2>` +
        `<div class='lb-ranking-grid'>${cards}</div>` +
        `</div></section>`
      );
    }
    case 'comparison_table': {
      // Keep only object rows: column extraction + cell reads assume a
      // mapping — anything else must degrade this block, not 500 the page.
      const rows = (Array.isArray(p.rows) ? p.rows : []).filter(isPlainObject);
      if (!rows.length) return '';
      const cols = Object.keys(rows[0]).filter((k) => k !== 'feature');
      const head =
        `<thead><tr><th data-el='header'>Feature</th>` +
        cols.map((c) => `<th data-el='header'>${esc(c)}</th>`).join('') +
        `</tr></thead>`;
      const bodyRows = rows
        .map((r) => {
          const tds = cols
            .map((c) => `<td>${esc(String(r[c] ?? ''))}</td>`)
            .join('');
          return `<tr><th class='lb-cell-feature' data-el='feature'>${esc(String(r.feature ?? ''))}</th>${tds}</tr>`;
        })
        .join('');
      return (
        `<section class='lb-comparison'>` +
        `<div class='lb-container'>` +
        `<h2 data-el='title'>${esc(p.title || 'Comparison')}</h2>` +
        `<table class='lb-table'>${head}<tbody>${bodyRows}</tbody></table>` +
        `</div></section>`
      );
    }
    case 'testimonial':
      return (
        `<blockquote class='lb-quote'>` +
        `<p data-el='quote'>${esc(p.quote || '')}</p>` +
        `<footer data-el='author'>— ${esc(p.author || 'Anonymous')}</footer>` +
        `</blockquote>`
      );
    case 'faq': {
      const items = (Array.isArray(p.items) ? p.items : []).filter(isPlainObject);
      const rows = items
        .map(
          (q) =>
            `<details class='lb-faq-item'>` +
            `<summary data-el='question'>${esc(q.q || '')}</summary>` +
            `<p data-el='answer'>${esc(q.a || '')}</p>` +
            `</details>`
        )
        .join('');
      return (
        `<section class='lb-faq'><div class='lb-container'>` +
        `<h2 data-el='title'>${esc(p.title || 'FAQ')}</h2>` +
        `${rows}` +
        `</div></section>`
      );
    }
    case 'product_grid': {
      const items = (Array.isArray(p.items) ? p.items : []).filter(isPlainObject);
      const cards = items
        .map(
          (it) =>
            `<article class='lb-product'>` +
            `<img data-el='image' src='${esc(it.image || '')}' alt=''/>` +
            `<h3 data-el='item_name'>${esc(it.name || '')}</h3>` +
            `<p data-el='item_summary'>${esc(it.summary || '')}</p>` +
            `<a class='lb-btn' data-el='cta' href='${safeHref(it.href || '#')}'>${esc(it.cta || 'View')}</a>` +
            `</article>`
        )
        .join('');
      return `<section class='lb-products'><div class='lb-container lb-products-grid'>${cards}</div></section>`;
    }
    case 'countdown':
      return (
        `<div class='lb-countdown' data-deadline='${esc(p.deadline || '')}'>` +
        `<span class='lb-countdown-label' data-el='label'>${esc(p.label || 'Offer ends in')}</span>` +
        `<span class='lb-countdown-clock' data-el='clock'>—</span></div>`
      );
    case 'sticky_cta': {
      const href = safeHref(p.href || '#');
      return `<a class='lb-sticky-cta' href='${href}'>${esc(p.text || 'Buy Now')}</a>`;
    }
    case 'embed':
    case 'html':
      // Operator-provided HTML — verbatim (see header). Scripts must survive.
      return p.html || '';
    case 'table': {
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const body = rows
        .filter(Array.isArray)
        .map(
          (r) =>
            '<tr>' + r.map((c) => `<td>${esc(String(c))}</td>`).join('') + '</tr>'
        )
        .join('');
      return `<table class='lb-table'><tbody>${body}</tbody></table>`;
    }
    default:
      return `<!-- unknown block type: ${esc(String(t))} -->`;
  }
}

// Port of render_block (published mode only — no builder bridge in this
// repo). Wraps the inner HTML in a data-blk-id envelope so per-block CSS
// selectors ([data-blk-id=…]) work like in the reference.
export function renderBlock(block) {
  let inner;
  try {
    inner = renderBlockInner(block);
  } catch (err) {
    // Fail open: one bad block becomes a visible-in-source comment stub,
    // never a page-wide failure.
    const t = esc(String((block || {}).type ?? 'unknown'));
    const msg = esc(String(err?.message || err));
    return `<!-- block render failed: type=${t} error=${msg} -->`;
  }
  const bid = esc((block || {}).id || '');
  const btype = esc((block || {}).type || '');
  const rawProps = (block || {}).props;
  const bname = esc(
    String((isPlainObject(rawProps) ? rawProps : {}).block_name || '')
  ).trim();
  const nameAttr = bname ? ` data-blk-name='${bname}'` : '';
  if (!bid) return inner;
  return (
    `<div class='lb-blk' data-blk-id='${bid}' data-blk-type='${btype}'${nameAttr}>` +
    `${inner}</div>`
  );
}

// ---------------------------------------------------------------------------
// Theme CSS — the reference's render_theme_css with its default token values
// (no theme system in this slice; defaults keep native blocks presentable).
// ---------------------------------------------------------------------------

const THEME_CSS = `
:root {
  --lb-primary: #2563EB;
  --lb-secondary: #10B981;
  --lb-accent: #F59E0B;
  --lb-dark: #111827;
  --lb-text: #374151;
  --lb-text-light: #6B7280;
  --lb-border: #E5E7EB;
  --lb-bg: #FFFFFF;
  --lb-muted: #F9FAFB;
  --lb-radius: 12px;
  --lb-radius-lg: 20px;
  --lb-container: 1200px;
  --lb-section-pad: 64px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: Inter, system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--lb-text);
  background: var(--lb-bg);
}
h1, h2, h3, h4, h5, h6 {
  font-family: Inter, system-ui, sans-serif;
  font-weight: 700;
  color: var(--lb-dark);
  margin: 0 0 0.5em;
  line-height: 1.2;
}
h1 { font-size: 2.8rem; }
h2 { font-size: 2rem; }
p { margin: 0 0 1em; }
a { color: var(--lb-primary); text-decoration: none; }
img { max-width: 100%; height: auto; }
.lb-container { max-width: var(--lb-container); margin: 0 auto; padding: 0 24px; }
.lb-btn {
  display: inline-block;
  background: #2563EB;
  color: #FFFFFF;
  padding: 12px 20px;
  border-radius: 12px;
  font-weight: 600;
  text-transform: none;
}
.lb-btn:hover { filter: brightness(1.08); }
.lb-hero { padding: var(--lb-section-pad) 0; background-size: cover; background-position: center; text-align: center; }
.lb-ranking { padding: var(--lb-section-pad) 0; }
.lb-ranking-grid { display: grid; gap: 16px; }
.lb-ranking-item { background: var(--lb-muted); border: 1px solid var(--lb-border); border-radius: var(--lb-radius); padding: 16px; display: flex; gap: 16px; align-items: flex-start; }
.lb-rank-no { font-size: 2rem; font-weight: 700; color: var(--lb-primary); min-width: 60px; }
.lb-rank-body { flex: 1; }
.lb-rank-summary { color: var(--lb-text-light); margin: 4px 0; }
.lb-rank-score { display: inline-block; padding: 2px 8px; background: var(--lb-accent); color: #fff; border-radius: 999px; font-size: 0.9rem; font-weight: 600; }
.lb-comparison { padding: var(--lb-section-pad) 0; }
.lb-table { width: 100%; border-collapse: collapse; border: 1px solid var(--lb-border); border-radius: var(--lb-radius); overflow: hidden; }
.lb-table th, .lb-table td { padding: 12px; border-bottom: 1px solid var(--lb-border); text-align: left; }
.lb-table thead { background: var(--lb-muted); font-weight: 600; }
.lb-cell-feature { background: var(--lb-muted); }
.lb-faq { padding: var(--lb-section-pad) 0; }
.lb-faq-item { background: var(--lb-muted); border: 1px solid var(--lb-border); border-radius: var(--lb-radius); padding: 16px; margin-bottom: 12px; }
.lb-faq-item summary { font-weight: 600; cursor: pointer; }
.lb-faq-item[open] { padding-bottom: 20px; }
.lb-products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; padding: var(--lb-section-pad) 24px; }
.lb-product { background: var(--lb-muted); border: 1px solid var(--lb-border); border-radius: var(--lb-radius); padding: 16px; text-align: center; }
.lb-product img { aspect-ratio: 1; object-fit: cover; border-radius: calc(var(--lb-radius) - 4px); }
.lb-quote { border-left: 4px solid var(--lb-primary); padding: 8px 16px; margin: 24px 0; font-style: italic; color: var(--lb-text-light); }
.lb-divider { border: 0; border-top: 1px solid var(--lb-border); margin: 24px 0; }
.lb-checklist { list-style: none; padding: 0; }
.lb-checklist li { padding: 6px 0; }
.lb-check { display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; background: var(--lb-secondary); color: #fff; border-radius: 999px; margin-right: 6px; font-size: 0.8rem; }
.lb-sticky-cta { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--lb-primary); color: #fff; padding: 12px 24px; border-radius: 999px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); z-index: 50; font-weight: 600; }
.lb-spacer { width: 100%; }
.lb-checkout, .lb-order-summary { max-width: 520px; margin: 24px auto; padding: 20px; background: var(--lb-bg); border: 1px solid var(--lb-border); border-radius: var(--lb-radius); }
.lb-order-summary-title { font-size: 1.15rem; margin: 0 0 12px; }
.fos-order-summary { margin-bottom: 16px; }
.fos-os-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--lb-border); }
.fos-os-row:last-child { border-bottom: 0; }
.fos-os-total { font-weight: 700; color: var(--lb-dark); border-top: 2px solid var(--lb-border); margin-top: 4px; padding-top: 12px; }
.fos-os-empty { color: var(--lb-text-light); font-size: 0.95rem; padding: 8px 0; }
.lb-whop-mount { min-height: 40px; margin: 8px 0 16px; }
.lb-checkout-error { color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-size: 0.95rem; }
.lb-checkout-fallback { display: block; width: 100%; text-align: center; border: 0; cursor: pointer; font-size: 1rem; box-sizing: border-box; }
`;

// ---------------------------------------------------------------------------
// Flow compilation (slice 4)
//
// The canvas edges (funnel.flow_layout.edges, keyed by PAGE ID) become a
// path-based routing object the page runtime reads. For the page being
// rendered we resolve:
//   • next_path     — slug of the 'main' edge's target page
//   • fallback_path — slug of the 'fallback' edge's target (the decline path
//                     on an upsell/downsell)
//   • routes        — { <button/block id>: <target slug> } for any per-button
//                     edge bindings (edge.buttons[]), when present
// Fail-open: an edge whose target is archived/missing is simply OMITTED — a
// stale flow_layout must never crash a serve. `pagesById` maps live page id →
// { slug }. When it is absent (renderer called without page context) the flow
// compiles to nulls rather than throwing.
// ---------------------------------------------------------------------------

export function compileFlow(page, funnel, pagesById) {
  const empty = { next_path: null, fallback_path: null, routes: {} };
  try {
    const flow = isPlainObject((funnel || {}).flow_layout) ? funnel.flow_layout : {};
    const edges = Array.isArray(flow.edges) ? flow.edges : [];
    const map = pagesById instanceof Map ? pagesById : new Map();
    const pid = String((page || {}).id ?? '');
    if (!pid) return empty;

    // #2: pages are served under /f/<funnelSlug>/... — flow targets must be
    // full public paths, not bare page slugs (a bare '/thankyou' navigates to
    // the site root and 404s). funnel.slug is [a-z0-9-]+ by construction.
    const funnelSlug = String((funnel || {}).slug || '');
    const toPublic = (slug) => {
      if (typeof slug !== 'string' || !funnelSlug) return null;
      const base = `/f/${funnelSlug}`;
      return slug === '/' ? base : base + slug;
    };
    const slugOf = (id) => {
      const p = map.get(String(id));
      return p && typeof p.slug === 'string' ? toPublic(p.slug) : null;
    };

    let next_path = null;
    let fallback_path = null;
    const routes = {};

    for (const e of edges) {
      if (!isPlainObject(e)) continue;
      if (String(e.source) !== pid) continue;
      const kind = e.kind === 'fallback' ? 'fallback' : 'main';
      const targetPath = slugOf(e.target);
      if (kind === 'main' && next_path === null && targetPath) next_path = targetPath;
      if (kind === 'fallback' && fallback_path === null && targetPath) fallback_path = targetPath;
      // Per-button bindings (optional; not persisted by the slice-3 canvas but
      // honoured here if a caller/import supplies them on the edge).
      const buttons = Array.isArray(e.buttons) ? e.buttons : [];
      for (const b of buttons) {
        if (!isPlainObject(b)) continue;
        const bid = b.id != null ? String(b.id) : '';
        const bpath = slugOf(b.target);
        if (bid && bpath && routes[bid] === undefined) routes[bid] = bpath;
      }
    }
    return { next_path, fallback_path, routes };
  } catch {
    return empty;
  }
}

// JSON for inline <script> embedding — escape the characters that could break
// out of the script element or the surrounding markup. Replacing '<' alone
// defeats '</script>'; '>' and '&' are escaped for defence-in-depth and the
// U+2028/U+2029 line separators because they are raw newlines in JS strings.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Minimal, defensive page runtime: publishes the flow data as window.__fos_flow
// and wires the common controls WITHOUT a framework —
//   • <a href="#fos-next">         → next_path
//   • <a href="#fos-fallback"> / [data-fos-decline] → fallback_path
//   • [data-lb-btn="<id>"] / [data-fos-route="<id>"] → routes[id]
// The point of this slice is that the DATA is emitted and correct; this wiring
// is a thin convenience, guarded so a malformed DOM can never throw.
function flowRuntimeScript(flow) {
  const json = jsonForScript(flow);
  return (
    `<script>window.__fos_flow=${json};` +
    `(function(){try{var F=window.__fos_flow||{};` +
    `function setHref(el,p){if(el&&p){el.setAttribute('href',p);}}` +
    `document.addEventListener('DOMContentLoaded',function(){try{` +
    `document.querySelectorAll('a[href="#fos-next"]').forEach(function(a){setHref(a,F.next_path);});` +
    `document.querySelectorAll('a[href="#fos-fallback"],[data-fos-decline]').forEach(function(a){setHref(a,F.fallback_path);});` +
    `var R=F.routes||{};` +
    `document.querySelectorAll('[data-fos-route]').forEach(function(a){setHref(a,R[a.getAttribute('data-fos-route')]);});` +
    `document.querySelectorAll('[data-lb-btn]').forEach(function(a){var id=a.getAttribute('data-lb-btn');if(id&&R[id])setHref(a,R[id]);});` +
    `}catch(e){}});}catch(e){}})();</script>`
  );
}

// ---------------------------------------------------------------------------
// CHECKOUT-JOIN runtime (slice: connect a published page to the money path).
//
// Emitted ONCE per page, only when a commerce block is present. It publishes
// window.__fos_checkout = { funnel_id, page_id, api_base } and then, on DOM
// ready, drives every whop_checkout block on the page through the EXACT public
// money-path contract (server/src/routes/checkoutPublic.js):
//
//  Hop A  POST {api_base}/create-session
//         body: { funnel_id, page_id, gateway:'whop',
//                 line_items:[{variant_id, quantity}] }    ← NO price, ever.
//         200 → { success, data:{ session_id, line_items[], totals, currency } }
//         422 empty_cart/invalid_variant/…   503 pricing_unavailable
//  Hop B  POST {api_base}/whop/create-session
//         body: { session_id }
//         200 → { success, data:{ whop_session_id (ch_…), purchase_url, … } }
//         503 gateway_not_configured   502 gateway_error
//  Hop C  set data-whop-checkout-session=<ch_…> on the mount div, load
//         https://js.whop.com/static/checkout/loader.js — the official loader
//         mounts the embedded checkout (which renders its own pay button).
//         purchase_url backs a fallback link if the embed script can't load.
//
// Postures:
//  • The client NEVER sends a price. Server re-prices (docs DATA-FLOW hop 6).
//  • FAIL VISIBLE: any non-200 shows a clear inline message and never hangs.
//  • FAIL OPEN on render: a misconfigured block already degraded to an inline
//    error at render time; the runtime is fully try/guarded so a malformed DOM
//    can never throw a page-wide error.
//  • XSS: session line-item titles from the server are written with
//    textContent (never innerHTML) so a hostile product title is inert. The
//    ch_ session id is written via setAttribute (an attribute value, not markup).
//
// NOTE: served pages here carry no CSP. If a CSP is ever added to the public
// funnel surface, it MUST allowlist Whop's embed origins (script-src
// https://js.whop.com; the embed also loads js.basistheory.com for card
// tokenization and talks to api.whop.com) or the embed cannot load.
// ---------------------------------------------------------------------------
function checkoutRuntimeScript(ctx) {
  const json = jsonForScript({
    funnel_id: ctx.funnel_id != null ? String(ctx.funnel_id) : null,
    page_id: ctx.page_id != null ? String(ctx.page_id) : null,
    api_base: '/api/v1/checkout/public',
  });
  // Compact, framework-free, fully guarded. Kept as one string so it emits as
  // a single inline <script>.
  const body = `(function(){
var CTX=window.__fos_checkout;var API=(CTX&&CTX.api_base)||'/api/v1/checkout/public';
function ready(fn){if(document.readyState!=='loading'){fn();}else{document.addEventListener('DOMContentLoaded',fn);}}
function money(n,c){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:(c||'USD')}).format(Number(n));}catch(e){return (c||'')+' '+Number(n||0).toFixed(2);}}
function showError(root,msg){try{var e=root.querySelector('[data-fos-error]');if(e){e.hidden=false;e.textContent=msg;}}catch(e){}}
function fillSummaries(session){try{var nodes=document.querySelectorAll('[data-fos-order-summary]');Array.prototype.forEach.call(nodes,function(node){try{node.innerHTML='';var cur=session.currency;(session.line_items||[]).forEach(function(li){var row=document.createElement('div');row.className='fos-os-row';var name=document.createElement('span');name.className='fos-os-name';name.textContent=(li.product_title||li.title||'Item')+((li.quantity>1)?(' \\u00d7 '+li.quantity):'');var price=document.createElement('span');price.className='fos-os-price';var lt=(li.line_total!=null)?li.line_total:(Number(li.price)*Number(li.quantity||1));price.textContent=money(lt,cur);row.appendChild(name);row.appendChild(price);node.appendChild(row);});var t=(session.totals||{});var trow=document.createElement('div');trow.className='fos-os-row fos-os-total';var tl=document.createElement('span');tl.textContent='Total';var tv=document.createElement('span');tv.textContent=money(t.total!=null?t.total:0,cur);trow.appendChild(tl);trow.appendChild(tv);node.appendChild(trow);}catch(e){}});}catch(e){}}
var whopLoaderStarted=false;
function loadWhopLoader(){if(whopLoaderStarted)return;whopLoaderStarted=true;var s=document.createElement('script');s.async=true;s.defer=true;s.src='https://js.whop.com/static/checkout/loader.js';(document.head||document.body).appendChild(s);}
function post(path,payload){return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload)}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,json:j};});});}
function sessErr(code){if(code==='pricing_unavailable')return 'Payment is temporarily unavailable. Please try again in a moment.';if(code==='invalid_variant'||code==='empty_cart')return 'This item is currently unavailable.';if(code==='total_below_minimum')return 'This order is below the minimum amount.';if(code==='rate_limited')return 'Too many attempts. Please wait a moment and retry.';return 'We could not start checkout ('+code+').';}
function embedErr(code){if(code==='gateway_not_configured')return 'Checkout is not fully set up yet. Please contact support.';if(code==='session_not_payable')return 'This checkout session has expired. Please refresh the page.';if(code==='gateway_error')return 'The payment provider is temporarily unavailable. Please try again shortly.';return 'We could not start the payment ('+code+').';}
function mountEmbed(root,embed){try{var mount=root.querySelector('[data-fos-whop-mount]');if(mount&&embed.whop_session_id){mount.setAttribute('data-whop-checkout-session',embed.whop_session_id);}var fb=root.querySelector('[data-fos-fallback]');if(fb&&embed.purchase_url){fb.setAttribute('href',embed.purchase_url);fb.hidden=false;}loadWhopLoader();}catch(e){showError(root,'Could not initialize the payment form.');}}
function initBlock(root){var cfg={};try{cfg=JSON.parse((root.querySelector('.fos-checkout-cfg')||{}).textContent||'{}');}catch(e){cfg={};}var items=(cfg&&cfg.line_items)||[];if(!items.length){showError(root,'This checkout has no product configured yet.');return;}
post('/create-session',{funnel_id:CTX.funnel_id,page_id:CTX.page_id,gateway:'whop',line_items:items}).then(function(res){if(res.status!==200||!res.json||!res.json.success){showError(root,sessErr((res.json&&res.json.error&&res.json.error.code)||('http_'+res.status)));return;}var session=res.json.data;window.__fos_checkout.session=session;fillSummaries(session);return post('/whop/create-session',{session_id:session.session_id}).then(function(er){if(er.status!==200||!er.json||!er.json.success){showError(root,embedErr((er.json&&er.json.error&&er.json.error.code)||('http_'+er.status)));return;}var embed=er.json.data;if(!embed||!embed.whop_session_id){showError(root,'Checkout is not fully set up yet (no session).');return;}mountEmbed(root,embed);});}).catch(function(){showError(root,'Network error starting checkout. Please try again.');});}
ready(function(){try{var blocks=document.querySelectorAll('[data-fos-checkout]');if(!blocks.length){return;}Array.prototype.forEach.call(blocks,function(b){try{initBlock(b);}catch(e){}});}catch(e){}});
})();`;
  return `<script>window.__fos_checkout=Object.assign(window.__fos_checkout||{},${json});${body}</script>`;
}

// ---------------------------------------------------------------------------
// Document assembly (port of render_page_html's skeleton).
// Pipeline order matches the reference:
//   head: charset/viewport → title/meta/og → theme css → custom_css → head_html
//   body: custom_html → <main>blocks</main> → custom_js → body_end_html
// ---------------------------------------------------------------------------

export function renderPageHtml(page, funnel, pagesById) {
  const pageSeo = isPlainObject((page || {}).seo) ? page.seo : {};
  const siteSeo = isPlainObject((funnel || {}).seo) ? funnel.seo : {};
  const title =
    pageSeo.title || siteSeo.site_title || (page || {}).title || 'Site';
  const desc = pageSeo.description || siteSeo.site_description || '';
  const og = pageSeo.og_image || siteSeo.og_image || '';
  const robots = pageSeo.robots || siteSeo.robots || 'index, follow';
  const favicon = siteSeo.favicon || '';

  const blocks = Array.isArray((page || {}).blocks) ? page.blocks : [];
  let blocksHtml;
  try {
    blocksHtml = blocks.map((b) => renderBlock(b)).join('');
  } catch (err) {
    // renderBlock is itself fail-open; this is the belt for the braces.
    blocksHtml = `<!-- blocks render failed: ${esc(String(err?.message || err))} -->`;
  }

  const pageCss = String((page || {}).custom_css || '');
  const pageJs = String((page || {}).custom_js || '');
  const customHtml = String((page || {}).custom_html || '');
  const headHtml = String((page || {}).head_html || '');
  const bodyEndHtml = String((page || {}).body_end_html || '');

  // Slice 4: compile the canvas flow for THIS page into window.__fos_flow.
  const flow = compileFlow(page, funnel, pagesById);
  const flowScript = flowRuntimeScript(flow);

  // CHECKOUT-JOIN: emit the checkout runtime ONLY when the page carries a
  // commerce block, so non-commerce pages stay byte-identical (and never load
  // the checkout code). funnel_id/page_id thread into create-session so the
  // right gateway credentials resolve server-side.
  const hasCommerce = blocks.some(
    (b) => isPlainObject(b) && COMMERCE_RUNTIME_TYPES.has(b.type)
  );
  const checkoutScript = hasCommerce
    ? checkoutRuntimeScript({
        funnel_id: (funnel || {}).id ?? null,
        page_id: (page || {}).id ?? null,
      })
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta name="robots" content="${esc(robots)}" />
${favicon ? `<link rel="icon" href="${esc(favicon)}"/>` : '<link rel="icon" href="data:,"/>'}
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
${og ? `<meta property="og:image" content="${esc(og)}"/>` : ''}
<style>${THEME_CSS}</style>
${pageCss ? `<style id="lb-page-css">${pageCss}</style>` : ''}
${flowScript}
${headHtml}
</head>
<body>
${customHtml}
<main>
${blocksHtml}
</main>
${checkoutScript}
${pageJs ? `<script>${pageJs}</script>` : ''}
${bodyEndHtml}
</body>
</html>`;
}

export default { renderPageHtml, renderBlock, escapeHtml, compileFlow };
