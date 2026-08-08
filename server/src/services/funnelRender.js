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
      const src = safeHref(p.src || '');
      const alt = esc(p.alt || '');
      return `<figure class='lb-image'><img data-el='image' src='${src}' alt='${alt}' loading='lazy'/></figure>`;
    }
    case 'video': {
      const src = safeHref(p.src || '');
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

// ---------------------------------------------------------------------------
// CHECKOUT PAGE TEMPLATE (checkout-template slice).
//
// Default seed for a page created with type='checkout' (funnels.js
// POST /:id/pages). Replicates the operator's live Whop checkout layout
// (docs/CHECKOUT-TEMPLATE-SPEC.md): two columns — left form (brand, urgency
// banner, Contact, Delivery, Shipping method, Billing checkbox, Payment card
// hosting the LIVE whop_checkout block, Complete-checkout button, trust
// badges, footer links), right order summary — stacking on mobile.
//
// Postures:
//  • This is CONTENT, not machinery: plain blocks[] + custom_css + custom_js,
//    stored on the page row like any operator-authored page. The operator
//    edits it on the canvas; deleting any block never breaks the others.
//  • The payment slot is the EXISTING whop_checkout block (untouched runtime).
//    It ships with NO variant_id — until the operator sets one, the block
//    renders its inline "no product configured" message and the page still
//    serves 200 (fail-open, same posture as the rest of the renderer).
//  • The two-column shell is pure CSS (grid on <main>, keyed off the seeded
//    data-blk-id wrappers). Blocks stay a flat, valid list — no unbalanced
//    tags across blocks, so the canvas can reorder/remove them safely.
//  • LIGHT theme on purpose: this is the buyer-facing page (its own theme),
//    even though the admin app is dark.
//  • All numbers shown are SERVER numbers: the order summary is filled by the
//    existing checkout runtime from the create-session response; the seeded
//    custom_js only ENRICHES it (Subtotal/Shipping rows, thumbnails) from the
//    same session object. Nothing is fabricated client-side; a Savings row is
//    only shown if the server ever supplies a discount amount.
//  • The static form fields are believable markup for now — the Whop embed
//    collects what it needs to charge (spec: "static markup in the template
//    for now").
// ---------------------------------------------------------------------------

const CKT_US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
  ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
  ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
  ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],
  ['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
  ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],
  ['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
];

const CKT_COUNTRIES = [
  ['US','United States'],['CA','Canada'],['GB','United Kingdom'],['AU','Australia'],
  ['DE','Germany'],['FR','France'],['IT','Italy'],['ES','Spain'],['NL','Netherlands'],
  ['NZ','New Zealand'],
];

function cktOptions(pairs, selected) {
  return pairs
    .map(
      ([v, label]) =>
        `<option value='${esc(v)}'${v === selected ? ' selected' : ''}>${esc(label)}</option>`
    )
    .join('');
}

// The template's layout + light-theme styles. Lives in page.custom_css so the
// operator can restyle without code. Selectors key off the seeded block ids
// (data-blk-id) and ckt-* classes only — native lb-* styles stay intact for
// any other block the operator later drops onto the page.
const CKT_TEMPLATE_CSS = `/* Checkout template (seeded) — buyer-facing LIGHT theme */
body{background:#fff;color:#111827;}
main{display:grid;grid-template-columns:minmax(0,1fr) 420px;column-gap:56px;row-gap:0;max-width:1180px;margin:0 auto;padding:28px 24px 64px;align-items:start;}
main>.lb-blk{grid-column:1;min-width:0;margin:0 0 26px;}
main>[data-blk-id='ckt_summary']{grid-column:2;grid-row:1/span 40;margin:0;align-self:stretch;border-left:1px solid #e2e2e2;background:#f7f7f7;padding-left:36px;}
/* Brand */
.ckt-brand{text-align:center;padding:8px 0 4px;}
.ckt-brand-link{display:inline-block;line-height:0;}
.ckt-brand-logo{height:36px;width:auto;display:inline-block;}
/* Urgency banner */
.ckt-banner{background:#fde8ef;color:#b4004e;border-radius:12px;padding:12px 18px;font-size:.95rem;font-weight:600;text-align:center;line-height:1.45;}
/* Sections + fields */
.ckt-h2{font-size:1.25rem;font-weight:700;color:#111;margin:0 0 12px;}
.ckt-note{color:#6b7280;font-size:.9rem;margin:-6px 0 12px;}
.ckt-field{margin-bottom:12px;}
.ckt-two{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
.ckt-input{width:100%;box-sizing:border-box;border:1.5px solid #cfcfcf;border-radius:8px;padding:16px 14px;font:400 16px/1.3 Inter,system-ui,sans-serif;color:#111;background:#fff;}
.ckt-input:focus{outline:2px solid rgba(37,99,235,.2);border-color:#2563eb;}
.ckt-input::placeholder{color:#9ca3af;}
.ckt-select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%236b7280' stroke-width='1.6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:34px;}
.ckt-phone{display:flex;align-items:stretch;}
.ckt-phone-prefix{display:flex;align-items:center;gap:5px;border:1.5px solid #cfcfcf;border-right:0;border-radius:8px 0 0 8px;padding:0 12px;background:#fff;color:#374151;font-size:15px;white-space:nowrap;}
.ckt-phone .ckt-input{border-radius:0 8px 8px 0;}
/* Floating-label field (country / state show a value + a small caption) */
.ckt-float{position:relative;}
.ckt-float>label{position:absolute;top:9px;left:14px;font-size:11px;line-height:1;color:#6b7280;pointer-events:none;z-index:1;}
.ckt-float>.ckt-input{padding-top:26px;padding-bottom:9px;}
/* Shipping method */
.ckt-ship{display:flex;flex-direction:column;gap:10px;}
.ckt-ship-option{display:flex;align-items:center;gap:12px;border:1px solid #dedede;border-radius:10px;padding:14px 16px;cursor:pointer;background:#fff;}
.ckt-ship-option input{accent-color:#2563eb;margin:0;}
.ckt-ship-option:has(input:checked){border-color:#2563eb;background:#eff3fe;box-shadow:inset 0 0 0 1px #2563eb;}
.ckt-ship-info{flex:1;display:flex;flex-direction:column;}
.ckt-ship-name{font-weight:600;color:#111;}
.ckt-ship-eta{color:#6b7280;font-size:.9rem;}
.ckt-ship-price{font-weight:700;color:#111;}
/* Billing checkbox (unchecking reveals the billing block — pure CSS) */
.ckt-checkline{display:flex;align-items:center;gap:10px;color:#111;font-size:.95rem;cursor:pointer;}
.ckt-check{width:18px;height:18px;accent-color:#2563eb;margin:0;}
.ckt-billing-fields{display:none;margin-top:14px;padding:16px;border:1px solid #ececec;border-radius:10px;background:#fafafa;}
.ckt-billing:has(.ckt-check:not(:checked)) .ckt-billing-fields{display:block;}
/* Payment card (head + whop mount + foot join into one visual card) */
main>[data-blk-id='ckt_payhead']{margin-bottom:0;}
main>[data-blk-id='ckt_whop']{margin-bottom:0;}
.ckt-pay-card{border:1px solid #dedede;background:#fff;}
.ckt-pay-card-top{border-radius:10px 10px 0 0;}
.ckt-pay-card-bottom{border-radius:0 0 10px 10px;border-top:0;}
.ckt-pay-option{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;font-weight:500;color:#111;border-bottom:0;}
.ckt-pay-card-bottom .ckt-pay-option{border-top:1px solid #ececec;}
.ckt-pay-option input{accent-color:#2563eb;margin:0;}
.ckt-pay-brands{margin-left:auto;display:flex;gap:6px;}
.ckt-brand-chip{border:1px solid #e3e3e3;border-radius:4px;padding:2px 7px;font-size:.68rem;font-weight:700;color:#374151;background:#fff;letter-spacing:.03em;}
.ckt-pay-brands svg{display:block;}
.ckt-pay-glyph{width:24px;display:inline-flex;justify-content:center;align-items:center;}
.ckt-pay-glyph svg{display:block;}
.ckt-pay-icon{display:inline-flex;align-items:center;}
.ckt-pay-icon svg{display:block;}
/* Static "Card information" fields inside the top pay card */
.ckt-card-fields{padding:0 16px 16px;}
.ckt-card-sublabel{font-size:.82rem;color:#6b7280;margin:2px 0 8px;}
.ckt-card-number{position:relative;margin-bottom:12px;}
.ckt-card-number .ckt-input{padding-right:104px;}
.ckt-card-brands{position:absolute;top:50%;right:10px;transform:translateY(-50%);display:flex;gap:5px;pointer-events:none;}
.ckt-card-brands svg{display:block;}
.ckt-fineprint{color:#6b7280;font-size:.85rem;margin:12px 2px 0;}
main>[data-blk-id='ckt_whop'] .lb-checkout{max-width:none;margin:0;border:1px solid #dedede;border-top:1px solid #ececec;border-bottom:0;border-radius:0;padding:16px;background:#fafafa;}
main>[data-blk-id='ckt_whop'] .lb-checkout-summary{display:none;}
main>[data-blk-id='ckt_whop'] .lb-checkout-fallback{display:none;} /* replaced by the Complete checkout button below */
/* Complete checkout */
.ckt-complete{display:block;width:100%;background:#111;color:#fff;border:0;border-radius:10px;padding:16px;font:700 1.05rem/1.2 Inter,system-ui,sans-serif;cursor:pointer;}
.ckt-complete:hover{background:#000;}
/* Footer links */
.ckt-footer{display:flex;gap:18px;border-top:1px solid #ececec;padding-top:16px;font-size:.85rem;}
.ckt-footer a{color:#6b7280;text-decoration:underline;}
.ckt-poweredby{color:#9ca3af;font-size:.78rem;margin:8px 2px 0;}
/* Right column: order summary */
.ckt-summary-inner{position:sticky;top:24px;background:transparent;border:0;border-radius:0;padding:24px 24px 28px 0;}
.ckt-summary-top{display:flex;justify-content:flex-end;margin-bottom:4px;}
.ckt-continue{display:inline-flex;align-items:center;gap:6px;color:#111;font-size:.9rem;font-weight:600;}
.ckt-lines .fos-os-row{border-bottom:0;padding:10px 0;align-items:center;}
.ckt-lines .fos-os-total{font-size:1.1rem;border-top:1px solid #e2e2e2;}
.ckt-usd{font-size:.72rem;font-weight:600;color:#6b7280;margin-right:5px;letter-spacing:.02em;}
.ckt-lines .fos-os-name{font-weight:600;line-height:1.3;}
.ckt-os-sub{display:block;color:#6b7280;font-size:.8rem;font-weight:400;margin-top:3px;}
.ckt-os-img{width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid #e5e5e5;margin-right:10px;vertical-align:middle;}
.ckt-promo{display:flex;gap:8px;margin:10px 0 4px;}
.ckt-promo .ckt-input{flex:1;}
.ckt-promo-apply{border:1px solid #d4d4d4;background:#f1f1f1;color:#555;border-radius:8px;padding:0 18px;font-weight:600;cursor:pointer;}
/* Mobile: single column, order summary first */
@media (max-width:900px){
  main{grid-template-columns:1fr;column-gap:0;padding:20px 16px 48px;}
  main>[data-blk-id='ckt_summary']{grid-column:1;grid-row:auto;order:-1;margin:0 0 28px;border-left:0;background:transparent;padding-left:0;}
  .ckt-summary-inner{position:static;background:#f7f7f7;border-radius:12px;padding:20px;}
}`;

// Seeded page-level JS. Two jobs, both defensive and both reading ONLY the
// server-created session the existing checkout runtime already holds:
//  1. "Complete checkout" button → opens the session's purchase_url (the same
//     href the runtime put on its fallback link, which the template hides).
//  2. Enrich the right-column summary with Subtotal/Shipping rows + line-item
//     thumbnails once the runtime has filled it. Text via textContent only.
const CKT_TEMPLATE_JS = `(function(){
  function q(s,r){return (r||document).querySelector(s);}
  document.addEventListener('click',function(ev){
    var btn=ev.target&&ev.target.closest&&ev.target.closest('[data-ckt-complete]');
    if(!btn)return;
    try{
      var fb=q('[data-fos-fallback]');
      var href=fb&&fb.getAttribute('href');
      if(href&&href!=='#'){window.open(href,'_blank','noopener');return;}
      var mount=q('[data-fos-whop-mount]');
      if(mount&&mount.scrollIntoView){mount.scrollIntoView({behavior:'smooth',block:'center'});}
    }catch(e){}
  });
  var tries=0;
  var timer=setInterval(function(){
    tries++;
    try{
      var s=window.__fos_checkout&&window.__fos_checkout.session;
      var box=q('.ckt-summary [data-fos-order-summary]');
      var totalRow=box&&box.querySelector('.fos-os-total');
      if(s&&box&&totalRow&&!box.querySelector('.ckt-os-extra')){
        clearInterval(timer);
        var totals=s.totals||{};var cur=s.currency||'USD';
        function money(n){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:cur}).format(Number(n));}catch(e){return cur+' '+Number(n||0).toFixed(2);}}
        function row(label,value){var d=document.createElement('div');d.className='fos-os-row ckt-os-extra';var a=document.createElement('span');a.textContent=label;var b=document.createElement('span');b.textContent=value;d.appendChild(a);d.appendChild(b);return d;}
        var items=s.line_items||[];
        var rows=box.querySelectorAll('.fos-os-row:not(.fos-os-total)');
        for(var i=0;i<rows.length&&i<items.length;i++){
          var it=items[i]||{};
          var nameEl=rows[i].querySelector('.fos-os-name');
          if(nameEl&&it.title&&String(it.title)!==String(it.product_title)&&!nameEl.querySelector('.ckt-os-sub')){
            var sub=document.createElement('span');sub.className='ckt-os-sub';sub.textContent='bundle: '+String(it.title);nameEl.appendChild(sub);
          }
          var img=it.image;
          if(img&&/^https?:\\/\\//i.test(String(img))){
            var el=document.createElement('img');el.className='ckt-os-img';el.alt='';el.src=String(img);
            rows[i].insertBefore(el,rows[i].firstChild);
          }
        }
        var promo=q('.ckt-summary .ckt-promo');
        if(promo){box.insertBefore(promo,totalRow);}
        if(totals.subtotal!=null){box.insertBefore(row('Subtotal',money(totals.subtotal)),totalRow);}
        var savings=(totals.savings!=null)?totals.savings:totals.discount;
        if(savings!=null&&Number(savings)>0){box.insertBefore(row('Savings','-'+money(savings)),totalRow);}
        var tvs=totalRow.getElementsByTagName('span');
        if(tvs&&tvs.length>=2&&!totalRow.querySelector('.ckt-usd')){var usd=document.createElement('span');usd.className='ckt-usd';usd.textContent='USD';tvs[1].insertBefore(usd,tvs[1].firstChild);}
      }
      if(tries>240){clearInterval(timer);}
    }catch(e){if(tries>240){clearInterval(timer);}}
  },250);
})();`;

// ---------------------------------------------------------------------------
// Inline, self-contained payment brand marks (no external assets). Small
// rounded-rect badges — used in the Payment card, the card-number field, and
// the trust-badge row. Static markup: no user data flows into these.
// ---------------------------------------------------------------------------
const CKT_ICON_CARD =
  `<svg width="22" height="16" viewBox="0 0 22 16" fill="none" aria-hidden="true"><rect x=".75" y=".75" width="20.5" height="14.5" rx="2.5" fill="#fff" stroke="#9ca3af" stroke-width="1.2"/><rect x="1.4" y="4" width="19.2" height="2.4" fill="#9ca3af"/><rect x="3.5" y="9.5" width="6" height="1.6" rx=".8" fill="#c4c9d2"/></svg>`;
const CKT_ICON_CRYPTO =
  `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#F7931A"/><text x="10" y="14.3" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="12" fill="#fff">₿</text></svg>`;
const CKT_ICON_BANK =
  `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#374151" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5 2.5 6.2h15L10 2.5z"/><path d="M4.3 8.2v5.6M8.1 8.2v5.6M11.9 8.2v5.6M15.7 8.2v5.6"/><path d="M2.5 16.4h15"/></svg>`;
// Mini marks (28x18) — Payment "Card" row + card-number field.
const CKT_MINI_VISA =
  `<svg width="28" height="18" viewBox="0 0 28 18" aria-hidden="true"><rect x=".5" y=".5" width="27" height="17" rx="3" fill="#fff" stroke="#e3e3e3"/><text x="14" y="12.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-style="italic" font-size="8" fill="#1A1F71">VISA</text></svg>`;
const CKT_MINI_MC =
  `<svg width="28" height="18" viewBox="0 0 28 18" aria-hidden="true"><rect x=".5" y=".5" width="27" height="17" rx="3" fill="#fff" stroke="#e3e3e3"/><circle cx="11.5" cy="9" r="5" fill="#EB001B"/><circle cx="16.5" cy="9" r="5" fill="#F79E1B"/><path d="M14 5.15a5 5 0 0 0 0 7.7 5 5 0 0 0 0-7.7z" fill="#FF5F00"/></svg>`;
const CKT_MINI_AMEX =
  `<svg width="28" height="18" viewBox="0 0 28 18" aria-hidden="true"><rect x=".5" y=".5" width="27" height="17" rx="3" fill="#2E77BC" stroke="#2E77BC"/><text x="14" y="12" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="6.5" fill="#fff">AMEX</text></svg>`;

// Returns { blocks, custom_css, custom_js } for a fresh 'checkout' page.
// Deliberately a function (not a frozen constant): every call mints fresh
// objects so one page's canvas edits can never alias another's seed.
export function checkoutPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });

  const blocks = [
    html('ckt_brand', 'checkout-brand',
      `<header class='ckt-brand'><a class='ckt-brand-link' href='#'><img class='ckt-brand-logo' alt='Puure' src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzgxIiBoZWlnaHQ9IjEwMCIgdmlld0JveD0iMCAwIDM4MSAxMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0zNzMuMDA4IDg0LjQ4ODNDMzc0LjEwNiA4NC40ODgzIDM3NS4xNSA4NC43MDgzIDM3Ni4xMzkgODUuMTQ4M0MzNzcuMTI3IDg1LjUzMzQgMzc3Ljk3OSA4Ni4wODM0IDM3OC42OTMgODYuNzk4NUMzNzkuNDA3IDg3LjQ1ODYgMzc5Ljk1NiA4OC4yODM3IDM4MC4zNDEgODkuMjczOEMzODAuNzggOTAuMjA4OSAzODEgOTEuMTk5IDM4MSA5Mi4yNDQxQzM4MSA5My4zNDQyIDM4MC43OCA5NC4zNjE4IDM4MC4zNDEgOTUuMjk2OUMzNzkuOTU2IDk2LjIzMiAzNzkuNDA3IDk3LjAyOTUgMzc4LjY5MyA5Ny42ODk2QzM3Ny45NzkgOTguNDA0NyAzNzcuMTI3IDk4Ljk1NDcgMzc2LjEzOSA5OS4zMzk4QzM3NS4xNSA5OS43Nzk4IDM3NC4xMDYgOTkuOTk5OCAzNzMuMDA4IDk5Ljk5OThDMzcxLjkwOSA5OS45OTk4IDM3MC44NjUgOTkuNzc5OCAzNjkuODc3IDk5LjMzOThDMzY4Ljg4OCA5OC45NTQ3IDM2OC4wMzcgOTguNDA0NyAzNjcuMzIzIDk3LjY4OTZDMzY2LjYwOSA5Ny4wMjk1IDM2Ni4wMzIgOTYuMjMyIDM2NS41OTIgOTUuMjk2OUMzNjUuMjA4IDk0LjM2MTggMzY1LjAxNiA5My4zNDQyIDM2NS4wMTYgOTIuMjQ0MUMzNjUuMDE2IDkxLjE5OSAzNjUuMjA4IDkwLjIwODkgMzY1LjU5MiA4OS4yNzM4QzM2Ni4wMzIgODguMjgzNyAzNjYuNjA5IDg3LjQ1ODYgMzY3LjMyMyA4Ni43OTg1QzM2OC4wMzcgODYuMDgzNCAzNjguODg4IDg1LjUzMzQgMzY5Ljg3NyA4NS4xNDgzQzM3MC44NjUgODQuNzA4MyAzNzEuOTA5IDg0LjQ4ODMgMzczLjAwOCA4NC40ODgzWiIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTMxOS4zNjcgOTkuMzM5OEMzMTQuMjU4IDk5LjMzOTggMzA5LjQ3OSA5OC40MDQ4IDMwNS4wMyA5Ni41MzQ2QzMwMC41ODEgOTQuNjA5NCAyOTYuNjgxIDkxLjk5NjYgMjkzLjMzMSA4OC42OTYzQzI4OS45OCA4NS4zOTYgMjg3LjM0MyA4MS41NDU2IDI4NS40MjEgNzcuMTQ1MUMyODMuNDk4IDcyLjY4OTcgMjgyLjUzNyA2Ny45MzE3IDI4Mi41MzcgNjIuODcxMkMyODIuNTM3IDU2LjgyMDYgMjgzLjQxNiA1MS4yMzc1IDI4NS4xNzQgNDYuMTIyQzI4Ni45MzEgNDAuOTUxNSAyODkuNDMxIDM2LjQ5NjEgMjkyLjY3MSAzMi43NTU3QzI5NS45MTIgMjkuMDE1MyAyOTkuNzg1IDI2LjEgMzA0LjI4OSAyNC4wMDk4QzMwOC44NDggMjEuODY0NiAzMTMuOTI5IDIwLjc5MiAzMTkuNTMxIDIwLjc5MkMzMjQuNDc1IDIwLjc5MiAzMjguOTc5IDIxLjY3MjEgMzMzLjA0NCAyMy40MzIzQzMzNy4xNjMgMjUuMTM3NCAzNDAuNjc5IDI3LjQ3NTIgMzQzLjU5IDMwLjQ0NTVDMzQ2LjU1NiAzMy4zNjA3IDM0OC44NjMgMzYuNzQzNiAzNTAuNTExIDQwLjU5NEMzNTIuMTU5IDQ0LjM4OTQgMzUyLjk4MyA0OC4zNzcyIDM1Mi45ODMgNTIuNTU3N0gyOTYuODczQzI5Ni44NzMgNTcuNjE4MiAyOTcuNTA1IDYyLjMyMTEgMjk4Ljc2OCA2Ni42NjY2QzMwMC4wODcgNzAuOTU3IDMwMS45MjcgNzQuNjY5OSAzMDQuMjg5IDc3LjgwNTJDMzA2LjY1MSA4MC45NDA1IDMwOS40NTIgODMuNDE1OCAzMTIuNjkzIDg1LjIzMDlDMzE1LjkzNCA4Ni45OTExIDMxOS41MDQgODcuODcxMiAzMjMuNDA0IDg3Ljg3MTJDMzI2LjY0NSA4Ny44NzEyIDMyOS43NDggODcuMzQ4NiAzMzIuNzE0IDg2LjMwMzVDMzM1LjczNSA4NS4yNTg0IDMzOC40NTQgODMuODgzMyAzNDAuODcxIDgyLjE3ODFDMzQzLjM0MyA4MC40MTggMzQ1LjQzIDc4LjQzNzggMzQ3LjEzMyA3Ni4yMzc1QzM0OC44MzYgNzQuMDM3MyAzNTAuMDQ0IDcxLjc1NDYgMzUwLjc1OCA2OS4zODk0TDM1NC45NiA3MS4yODdDMzUzLjg2MiA3NS4xMzc0IDM1Mi4xMzEgNzguNzY3OCAzNDkuNzY5IDgyLjE3ODFDMzQ3LjQwOCA4NS41ODg1IDM0NC42MDYgODguNTU4OCAzNDEuMzY1IDkxLjA4OUMzMzguMTggOTMuNjE5MyAzMzQuNjkyIDk1LjYyNyAzMzAuOTAyIDk3LjExMjFDMzI3LjExMSA5OC41OTczIDMyMy4yNjcgOTkuMzM5OCAzMTkuMzY3IDk5LjMzOThaTTMzNC4yOCA0Ni41MzQ2QzMzNC4yOCA0My42NzQzIDMzMy43NTggNDEuMDM0IDMzMi43MTQgMzguNjEzOEMzMzEuNzI1IDM2LjEzODUgMzMwLjM1MiAzMy45OTMzIDMyOC41OTUgMzIuMTc4MUMzMjYuODM3IDMwLjM2MjkgMzI0Ljc3NyAyOC45NjAzIDMyMi40MTUgMjcuOTcwMkMzMjAuMDUzIDI2LjkyNTEgMzE3LjUyNiAyNi40MDI2IDMxNC44MzUgMjYuNDAyNkMzMTIuNTgzIDI2LjQwMjYgMzEwLjQxMyAyNi45MjUxIDMwOC4zMjYgMjcuOTcwMkMzMDYuMjk0IDI4Ljk2MDMgMzA0LjQ4MSAzMC4zNjI5IDMwMi44ODggMzIuMTc4MUMzMDEuMjk1IDMzLjk5MzMgMjk5Ljk0OSAzNi4xMzg1IDI5OC44NTEgMzguNjEzOEMyOTcuODA3IDQxLjAzNCAyOTcuMTc2IDQzLjY3NDMgMjk2Ljk1NiA0Ni41MzQ2SDMzNC4yOFoiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0yMzEuNjk4IDIyLjM1OTZIMjQ2LjUyOVYzNi42MzM2QzI0OC4wMTIgMzQuNDg4NCAyNDkuNTc3IDMyLjQ4MDcgMjUxLjIyNSAzMC42MTA1QzI1Mi45MjggMjguNjg1MyAyNTQuNjg2IDI3LjAwNzYgMjU2LjQ5OCAyNS41Nzc1QzI1OC4zMTEgMjQuMDkyMyAyNjAuMTc5IDIyLjkzNzIgMjYyLjEwMSAyMi4xMTIxQzI2NC4wNzkgMjEuMjMyIDI2Ni4wNTYgMjAuNzkyIDI2OC4wMzMgMjAuNzkyQzI2OS42ODEgMjAuNzkyIDI3MS4xOTIgMjEuMDM5NSAyNzIuNTY1IDIxLjUzNDZDMjczLjk5MyAyMi4wMjk2IDI3NS4yMjkgMjIuNjg5NyAyNzYuMjczIDIzLjUxNDhDMjc3LjMxNiAyNC4zMzk4IDI3OC4xNCAyNS4zMDI0IDI3OC43NDQgMjYuNDAyNkMyNzkuMzQ5IDI3LjUwMjcgMjc5LjY1MSAyOC42NTc4IDI3OS42NTEgMjkuODY3OUMyNzkuNjUxIDMyLjM0MzEgMjc4Ljg4MiAzNC4xODU4IDI3Ny4zNDQgMzUuMzk2QzI3NS44NjEgMzYuNjA2MSAyNzMuNzczIDM3LjIxMTEgMjcxLjA4MiAzNy4yMTExQzI2OS40MzQgMzcuMjExMSAyNjguMDg4IDM3LjA0NjEgMjY3LjA0NSAzNi43MTYxQzI2Ni4wNTYgMzYuMzMxIDI2NS4xNSAzNS45NDYgMjY0LjMyNiAzNS41NjFDMjYzLjUwMiAzNS4xMjA5IDI2Mi42NzggMzQuNzM1OSAyNjEuODU0IDM0LjQwNTlDMjYxLjAzIDM0LjAyMDggMjU5Ljk1OSAzMy44MjgzIDI1OC42NDEgMzMuODI4M0MyNTYuNjYzIDMzLjgyODMgMjU0LjY1OCAzNC45Mjg0IDI1Mi42MjYgMzcuMTI4NkMyNTAuNjQ5IDM5LjMyODggMjQ4LjYxNiA0Mi4xMzQxIDI0Ni41MjkgNDUuNTQ0NVY5Ny42ODk3SDIzMS42OThWMjIuMzU5NloiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0xNjguMjUzIDIyLjM1OTRWNzUuOTg5N0MxNjguMjUzIDc3Ljg1OTkgMTY4LjY5MiA3OS42MjAxIDE2OS41NzEgODEuMjcwM0MxNzAuNDUgODIuODY1NCAxNzEuNjMxIDg0LjI5NTYgMTczLjExNCA4NS41NjA3QzE3NC41OTcgODYuNzcwOCAxNzYuMzI3IDg3LjczMzQgMTc4LjMwNSA4OC40NDg1QzE4MC4zMzcgODkuMTYzNiAxODIuNTA3IDg5LjUyMTEgMTg0LjgxNCA4OS41MjExQzE4Ni4yOTcgODkuNTIxMSAxODcuODkgODkuMjE4NiAxODkuNTkzIDg4LjYxMzVDMTkxLjI5NSA4Ny45NTM0IDE5Mi45NDMgODcuMDczMyAxOTQuNTM2IDg1Ljk3MzJDMTk2LjEyOSA4NC44NzMxIDE5Ny42NCA4My41ODA1IDE5OS4wNjggODIuMDk1NEMyMDAuNDk2IDgwLjYxMDIgMjAxLjY3NyA3OS4wNDI1IDIwMi42MTEgNzcuMzkyNFYyMi4zNTk0SDIxNy41MjRWOTcuNjg5NEgyMDIuNjExVjgzLjU4MDVDMjAxLjI5MiA4NS43MjU3IDE5OS42NDQgODcuNzYwOSAxOTcuNjY3IDg5LjY4NjFDMTk1LjY5IDkxLjYxMTMgMTkzLjUyIDkzLjI4OSAxOTEuMTU4IDk0LjcxOTFDMTg4Ljg1MSA5Ni4xNDkzIDE4Ni40NjIgOTcuMjc2OSAxODMuOTkgOTguMTAyQzE4MS41NzMgOTguOTI3IDE3OS4yNjYgOTkuMzM5NiAxNzcuMDY5IDk5LjMzOTZDMTczLjc3MyA5OS4zMzk2IDE3MC42NyA5OC43MzQ1IDE2Ny43NTkgOTcuNTI0NEMxNjQuOTAyIDk2LjI1OTMgMTYyLjQwMyA5NC41ODE2IDE2MC4yNjEgOTIuNDkxNEMxNTguMTE5IDkwLjM0NjIgMTU2LjQxNiA4Ny44NzA5IDE1NS4xNTIgODUuMDY1NkMxNTMuOTQ0IDgyLjIwNTQgMTUzLjM0IDc5LjE4MDEgMTUzLjM0IDc1Ljk4OTdWMjIuMzU5NEgxNjguMjUzWiIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTg5Ljg5MzUgMjIuMzU5NFY3NS45ODk3Qzg5Ljg5MzUgNzcuODU5OSA5MC4zMzMgNzkuNjIwMSA5MS4yMTE4IDgxLjI3MDNDOTIuMDkwNyA4Mi44NjU0IDkzLjI3MTYgODQuMjk1NiA5NC43NTQ3IDg1LjU2MDdDOTYuMjM3OCA4Ni43NzA4IDk3Ljk2OCA4Ny43MzM0IDk5Ljk0NTQgODguNDQ4NUMxMDEuOTc4IDg5LjE2MzYgMTA0LjE0NyA4OS41MjExIDEwNi40NTQgODkuNTIxMUMxMDcuOTM3IDg5LjUyMTEgMTA5LjUzIDg5LjIxODYgMTExLjIzMyA4OC42MTM1QzExMi45MzYgODcuOTUzNCAxMTQuNTg0IDg3LjA3MzMgMTE2LjE3NyA4NS45NzMyQzExNy43NyA4NC44NzMxIDExOS4yOCA4My41ODA1IDEyMC43MDggODIuMDk1NEMxMjIuMTM2IDgwLjYxMDIgMTIzLjMxNyA3OS4wNDI1IDEyNC4yNTEgNzcuMzkyNFYyMi4zNTk0SDEzOS4xNjRWOTcuNjg5NEgxMjQuMjUxVjgzLjU4MDVDMTIyLjkzMyA4NS43MjU3IDEyMS4yODUgODcuNzYwOSAxMTkuMzA4IDg5LjY4NjFDMTE3LjMzIDkxLjYxMTMgMTE1LjE2MSA5My4yODkgMTEyLjc5OSA5NC43MTkxQzExMC40OTIgOTYuMTQ5MyAxMDguMTAyIDk3LjI3NjkgMTA1LjYzMSA5OC4xMDJDMTAzLjIxNCA5OC45MjcgMTAwLjkwNyA5OS4zMzk2IDk4LjcwOTUgOTkuMzM5NkM5NS40MTM4IDk5LjMzOTYgOTIuMzEwNCA5OC43MzQ1IDg5LjM5OTIgOTcuNTI0NEM4Ni41NDI5IDk2LjI1OTMgODQuMDQzNyA5NC41ODE2IDgxLjkwMTQgOTIuNDkxNEM3OS43NTkyIDkwLjM0NjIgNzguMDU2NSA4Ny44NzA5IDc2Ljc5MzEgODUuMDY1NkM3NS41ODQ3IDgyLjIwNTQgNzQuOTgwNSA3OS4xODAxIDc0Ljk4MDUgNzUuOTg5N1YyMi4zNTk0SDg5Ljg5MzVaIiBmaWxsPSJibGFjayIvPgo8cGF0aCBkPSJNMCAwSDMwLjg5NzJDMzYuMDA1NiAwIDQwLjc4NDMgMC42MzI1NjMgNDUuMjMzNSAxLjg5NzY5QzQ5LjY4MjcgMy4xMDc4MSA1My41NTUyIDQuODk1NDkgNTYuODUwOSA3LjI2MDczQzYwLjE0NjYgOS42MjU5NiA2Mi43MjgyIDEyLjU0MTMgNjQuNTk1OCAxNi4wMDY2QzY2LjUxODMgMTkuNDcxOSA2Ny40Nzk1IDIzLjQzMjMgNjcuNDc5NSAyNy44ODc4QzY3LjQ3OTUgMzIuMzQzMiA2Ni41NDU3IDM2LjIyMTEgNjQuNjc4MiAzOS41MjE1QzYyLjg2NTUgNDIuODIxOCA2MC40NDg3IDQ1LjU0NDYgNTcuNDI3NiA0Ny42ODk4QzU0LjQwNjYgNDkuODM1IDUwLjk3MzUgNTEuNDU3NiA0Ny4xMjg2IDUyLjU1NzhDNDMuMzM4NSA1My42MDI5IDM5LjQzODYgNTQuMTI1NCAzNS40Mjg4IDU0LjEyNTRDMzMuNzI2IDU0LjEyNTQgMzEuOTQwOSA1NC4wOTc5IDMwLjA3MzMgNTQuMDQyOUMyOC4yMDU3IDUzLjkzMjkgMjYuMzkzMSA1My43OTU0IDI0LjYzNTQgNTMuNjMwNEMyMi45MzI2IDUzLjQ2NTMgMjEuMzM5NyA1My4zMDAzIDE5Ljg1NjYgNTMuMTM1M0MxOC40Mjg1IDUyLjkxNTMgMTcuMjc1IDUyLjY5NTMgMTYuMzk2MSA1Mi40NzUyVjk3LjY4OThIMFYwWk0xNi4zOTYxIDQ2Ljk0NzJDMTguMjA4OCA0Ny40NDIyIDIwLjE1ODcgNDcuOTM3MyAyMi4yNDYgNDguNDMyM0MyNC4zODgyIDQ4LjkyNzQgMjYuNTU3OSA0OS4xNzQ5IDI4Ljc1NSA0OS4xNzQ5QzMyLjI3MDQgNDkuMTc0OSAzNS4zNDY0IDQ4LjY1MjQgMzcuOTgzIDQ3LjYwNzNDNDAuNjc0NSA0Ni41MDcxIDQyLjg3MTYgNDUuMDQ5NSA0NC41NzQ0IDQzLjIzNDNDNDYuMzMyMSA0MS40MTkxIDQ3LjY1MDQgMzkuMjczOSA0OC41MjkyIDM2Ljc5ODdDNDkuNDA4MSAzNC4zMjM0IDQ5Ljg0NzUgMzEuNjgzMiA0OS44NDc1IDI4Ljg3NzlDNDkuODQ3NSAyNS41Nzc2IDQ5LjI3MDggMjIuNjA3MyA0OC4xMTczIDE5Ljk2N0M0Ny4wMTg3IDE3LjI3MTcgNDUuNDgwNyAxNC45ODkgNDMuNTAzMyAxMy4xMTg4QzQxLjUyNTkgMTEuMjQ4NiAzOS4xOTE0IDkuODE4NDggMzYuNDk5OSA4LjgyODM4QzMzLjg2MzMgNy43ODMyOCAzMS4wMzQ1IDcuMjYwNzMgMjguMDEzNSA3LjI2MDczSDE2LjM5NjFWNDYuOTQ3MloiIGZpbGw9ImJsYWNrIi8+Cjwvc3ZnPgo='></a></header>`),
    html('ckt_banner', 'checkout-urgency-banner',
      `<div class='ckt-banner'>Our most-loved breast lift device is currently in high demand. Order today while inventory lasts</div>`),
    html('ckt_contact', 'checkout-contact',
      `<section class='ckt-section'><h2 class='ckt-h2'>Contact</h2>` +
      `<div class='ckt-field'><input class='ckt-input' type='email' name='email' placeholder='Email' autocomplete='email' required></div>` +
      `<div class='ckt-field ckt-phone'><span class='ckt-phone-prefix'>\u{1F1FA}\u{1F1F8} +1</span><input class='ckt-input' type='tel' name='phone' placeholder='Phone (optional)' autocomplete='tel'></div>` +
      `</section>`),
    html('ckt_delivery', 'checkout-delivery',
      `<section class='ckt-section'><h2 class='ckt-h2'>Delivery</h2>` +
      `<div class='ckt-field ckt-float'><label>Country</label><select class='ckt-input ckt-select' name='country' autocomplete='country'>${cktOptions(CKT_COUNTRIES, 'US')}</select></div>` +
      `<div class='ckt-two'><input class='ckt-input' type='text' name='first_name' placeholder='First name' autocomplete='given-name'><input class='ckt-input' type='text' name='last_name' placeholder='Last name' autocomplete='family-name'></div>` +
      `<div class='ckt-field'><input class='ckt-input' type='text' name='address1' placeholder='Address' autocomplete='address-line1'></div>` +
      `<div class='ckt-field'><input class='ckt-input' type='text' name='address2' placeholder='Apartment, suite, etc. (optional)' autocomplete='address-line2'></div>` +
      `<div class='ckt-field'><input class='ckt-input' type='text' name='city' placeholder='City' autocomplete='address-level2'></div>` +
      `<div class='ckt-two'><div class='ckt-float'><label>State/province</label><select class='ckt-input ckt-select' name='state' autocomplete='address-level1'><option value='' selected disabled></option>${cktOptions(CKT_US_STATES)}</select></div><input class='ckt-input' type='text' name='postal' placeholder='Postal code' autocomplete='postal-code'></div>` +
      `</section>`),
    html('ckt_shipping', 'checkout-shipping-method',
      `<section class='ckt-section'><h2 class='ckt-h2'>Shipping method</h2>` +
      `<div class='ckt-ship'>` +
      `<label class='ckt-ship-option'><input type='radio' name='ckt-ship' checked><span class='ckt-ship-info'><span class='ckt-ship-name'>Free tracked Shipping</span><span class='ckt-ship-eta'>6-8 business days</span></span><span class='ckt-ship-price'>FREE</span></label>` +
      `</div></section>`),
    html('ckt_billing', 'checkout-billing',
      `<section class='ckt-section ckt-billing'>` +
      `<label class='ckt-checkline'><input type='checkbox' class='ckt-check' checked><span>Billing address same as shipping address</span></label>` +
      `<div class='ckt-billing-fields'>` +
      `<div class='ckt-two'><input class='ckt-input' type='text' name='billing_first_name' placeholder='First name'><input class='ckt-input' type='text' name='billing_last_name' placeholder='Last name'></div>` +
      `<div class='ckt-field'><input class='ckt-input' type='text' name='billing_address1' placeholder='Address'></div>` +
      `<div class='ckt-two'><input class='ckt-input' type='text' name='billing_city' placeholder='City'><input class='ckt-input' type='text' name='billing_postal' placeholder='ZIP code'></div>` +
      `</div></section>`),
    html('ckt_payhead', 'checkout-payment-heading',
      `<section class='ckt-section'><h2 class='ckt-h2'>Payment method</h2><p class='ckt-note'>All transactions are secure and encrypted.</p>` +
      `<div class='ckt-pay-card ckt-pay-card-top'>` +
      `<label class='ckt-pay-option'><input type='radio' name='ckt-pay' checked><span class='ckt-pay-icon'>${CKT_ICON_CARD}</span><span>Card</span></label>` +
      `<div class='ckt-card-fields'>` +
      `<div class='ckt-card-sublabel'>Card information</div>` +
      `<div class='ckt-card-number'><input class='ckt-input' type='text' name='card_number' placeholder='1234 1234 1234 1234' autocomplete='cc-number' inputmode='numeric'><span class='ckt-card-brands'>${CKT_MINI_VISA}${CKT_MINI_MC}${CKT_MINI_AMEX}</span></div>` +
      `<div class='ckt-two'><input class='ckt-input' type='text' name='card_exp' placeholder='MM / YY' autocomplete='cc-exp' inputmode='numeric'><input class='ckt-input' type='text' name='card_cvc' placeholder='CVC' autocomplete='cc-csc' inputmode='numeric'></div>` +
      `</div></div></section>`),
    {
      id: 'ckt_whop',
      type: 'whop_checkout',
      props: { block_name: 'checkout-payment', quantity: 1, button_text: 'Complete checkout' },
    },
    html('ckt_payfoot', 'checkout-payment-options',
      `<section class='ckt-section'><div class='ckt-pay-card ckt-pay-card-bottom'>` +
      `<label class='ckt-pay-option'><input type='radio' name='ckt-pay'><span class='ckt-pay-glyph'>${CKT_ICON_CRYPTO}</span><span>Pay with Crypto</span></label>` +
      `<label class='ckt-pay-option'><input type='radio' name='ckt-pay'><span class='ckt-pay-glyph'>${CKT_ICON_BANK}</span><span>Bank transfer</span></label>` +
      `</div>` +
      `<p class='ckt-fineprint'>By purchasing, you agree to Puure's terms and conditions.</p>` +
      `<p class='ckt-poweredby'>Powered by Whop \u00b7 Terms \u00b7 Privacy</p></section>`),
    html('ckt_button', 'checkout-complete-button',
      `<button type='button' class='ckt-complete' data-ckt-complete>Complete checkout</button>`),
    html('ckt_footer', 'checkout-footer-links',
      `<footer class='ckt-footer'><a href='#'>Return policy</a><a href='#'>Privacy policy</a><a href='#'>Terms of service</a></footer>`),
    html('ckt_summary', 'checkout-order-summary',
      `<aside class='ckt-summary'><div class='ckt-summary-inner'>` +
      `<div class='ckt-summary-top'><a class='ckt-continue' href='#'><svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' aria-hidden='true'><circle cx='9' cy='21' r='1'/><circle cx='20' cy='21' r='1'/><path d='M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6'/></svg> Continue shopping</a></div>` +
      `<h2 class='ckt-h2'>Order summary</h2>` +
      `<div class='ckt-lines fos-order-summary' data-fos-order-summary><div class='fos-os-empty'>Your order will appear here.</div></div>` +
      `<div class='ckt-promo'><input class='ckt-input' type='text' name='promo' placeholder='Promo code'><button type='button' class='ckt-promo-apply'>Apply</button></div>` +
      `</div></aside>`),
  ];

  return { blocks, custom_css: CKT_TEMPLATE_CSS, custom_js: CKT_TEMPLATE_JS };
}

export default { renderPageHtml, renderBlock, escapeHtml, compileFlow, checkoutPageTemplate };
