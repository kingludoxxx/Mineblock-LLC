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

// TRACKING-LANE HOOK (feat/tracking-attribution): the consent-first tracking
// runtime is emitted as ONE <head> script by trackingHeadScript(). This is the
// single injection point the tracking lane touches in this file — see its use
// in renderPageHtml() below. No other edits here belong to the tracking lane.
import { trackingHeadScript } from './trackingRuntime.js';

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

// Upsell block types that require the 1-click upsell runtime + page context
// (funnel_id / page_id). Presence of any of these turns on upsellRuntimeScript();
// a page without them never loads the upsell code.
const UPSELL_RUNTIME_TYPES = new Set(['upsell_offer']);

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
        `<div class='lb-whop-wait' data-fos-whop-wait>Enter your email and delivery address above to load the secure payment form.</div>` +`<div class='lb-whop-mount' data-fos-whop-mount></div>` +
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
    case 'upsell_offer': {
      // Buyer-facing 1-CLICK post-purchase upsell. Emits ONLY structure + a
      // JSON config of {offer_id?} — the price, image and name are filled at
      // runtime from the SERVER-priced /upsell/offer endpoint, NEVER from block
      // config (a price on props is ignored, exactly like whop_checkout). The
      // two controls are a prominent one-click Accept (charges the saved PM off
      // the paid base session) and a plain Decline; both advance via the
      // compiled funnel flow. No card fields — the whole point is one click on
      // the already-saved method. The driving runtime is upsellRuntimeScript(),
      // emitted once at page level when any upsell_offer block is present.
      const offerId = p.offer_id != null ? String(p.offer_id).trim().slice(0, 80) : '';
      // jsonForScript() escapes '<' so an offer id containing '</script>' can
      // never break out of the application/json island.
      const cfgJson = jsonForScript({ offer_id: offerId || null });
      const headline = esc(String(p.headline || 'Wait — one exclusive offer before you go'));
      const sub = esc(
        String(p.subheadline || 'Add this to your order with one click. No need to re-enter your details.')
      );
      const acceptText = esc(String(p.accept_text || 'Add this to my order'));
      const declineText = esc(String(p.decline_text || 'No thanks, I’ll pass on this one-time offer'));
      const fine = esc(
        String(
          p.fine_print ||
            'This is a one-time charge to the payment method from your original order — not a subscription. ' +
              'By clicking, you authorize the charge shown above.'
        )
      );
      return (
        `<section class='lb-upsell fos-upsell' data-fos-upsell>` +
        `<div class='lb-upsell-headline' data-el='headline'>${headline}</div>` +
        `<p class='lb-upsell-sub' data-el='subheadline'>${sub}</p>` +
        `<div class='lb-upsell-card'>` +
        `<div class='lb-upsell-media'><img class='lb-upsell-img' data-fos-up-image alt='' loading='lazy' hidden/></div>` +
        `<div class='lb-upsell-info'>` +
        `<div class='lb-upsell-name' data-fos-up-title>Loading your offer…</div>` +
        `<div class='lb-upsell-pricing'>` +
        `<span class='lb-upsell-price' data-fos-up-price></span>` +
        `<span class='lb-upsell-original' data-fos-up-original hidden></span>` +
        `<span class='lb-upsell-save' data-fos-up-badge hidden></span>` +
        `</div></div></div>` +
        `<div class='lb-upsell-error' data-fos-up-error hidden></div>` +
        `<div class='lb-upsell-actions'>` +
        `<button type='button' class='lb-upsell-accept' data-fos-up-accept disabled>${acceptText}</button>` +
        `<button type='button' class='lb-upsell-decline' data-fos-up-decline>${declineText}</button>` +
        `</div>` +
        `<div class='lb-upsell-status' data-fos-up-status hidden>` +
        `<span class='lb-upsell-spinner' aria-hidden='true'></span>` +
        `<span data-fos-up-status-msg>Processing…</span></div>` +
        `<p class='lb-upsell-fine'>${fine}</p>` +
        `<script type='application/json' class='fos-upsell-cfg'>${cfgJson}</script>` +
        `</section>`
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
    // ── PAGE-TYPES slice: new block renderers (additive — see the template
    //    sections at the bottom of this file for the runtimes that drive them).
    case 'order_confirmation': {
      // Thank-you page order recap. Emits ONLY structure — line items and
      // totals are filled at runtime by thankYouRuntimeScript() from the
      // EXISTING public GET /session/:id snapshot (routes/checkoutPublic.js,
      // hand-picked safe fields; NO new money endpoints). All server data is
      // written with textContent so a hostile product title is inert.
      const title = esc(String(p.title || 'Order summary'));
      const note = esc(
        String(p.note || 'A confirmation email is on its way to your inbox.')
      );
      return (
        `<section class='lb-orderconf' data-fos-orderconf>` +
        `<h3 class='lb-orderconf-title' data-fos-thankyou-title>${title}</h3>` +
        `<div class='fos-order-summary' data-fos-order-summary>` +
        `<div class='fos-os-empty'>Your order details will appear here.</div></div>` +
        `<p class='lb-orderconf-note' data-fos-thankyou-note>${note}</p>` +
        `</section>`
      );
    }
    case 'optin_form': {
      // Lead capture (opt-in page). Posts via optinRuntimeScript() to the
      // opt-in public intake (routes/optinPublic.js) — never to a money
      // endpoint. The `website` field is a honeypot: visually hidden (CSS),
      // real buyers leave it empty, bots fill it and the server silently
      // drops the lead. On success the runtime advances via the compiled flow.
      const headline = p.headline != null ? esc(String(p.headline)) : '';
      const btn = esc(String(p.button_text || 'Continue'));
      const emailPh = esc(String(p.email_placeholder || 'Email address'));
      const namePh = esc(String(p.name_placeholder || 'First name (optional)'));
      const showName = p.name_enabled !== false;
      const success = esc(String(p.success_text || 'You are in! Check your inbox.'));
      return (
        `<form class='lb-optin' data-fos-optin novalidate>` +
        (headline ? `<div class='lb-optin-headline'>${headline}</div>` : '') +
        (showName
          ? `<div class='lb-optin-field'><input class='lb-optin-input' type='text' name='name' placeholder='${namePh}' autocomplete='given-name' maxlength='120'/></div>`
          : '') +
        `<div class='lb-optin-field'><input class='lb-optin-input' type='email' name='email' placeholder='${emailPh}' autocomplete='email' required maxlength='254'/></div>` +
        `<div class='lb-optin-hp'><input type='text' name='website' tabindex='-1' autocomplete='off' aria-hidden='true'/></div>` +
        `<div class='lb-optin-error' data-fos-optin-error hidden></div>` +
        `<div class='lb-optin-success' data-fos-optin-success hidden>${success}</div>` +
        `<button type='submit' class='lb-optin-submit' data-fos-optin-submit>${btn}</button>` +
        `</form>`
      );
    }
    case 'storefront_grid': {
      // Operator-configured product cards (no live Shopify fetch in v1).
      // `price` is a DISPLAY STRING (e.g. "$49.99") — no money math happens
      // here; real pricing stays server-side on whatever page the card links
      // into (funnel path or safeHref external URL).
      const items = (Array.isArray(p.items) ? p.items : []).filter(isPlainObject);
      if (!items.length) return `<!-- storefront_grid: no items configured -->`;
      const cards = items
        .map((it) => {
          const img = it.image
            ? `<img class='lb-sf-img' src='${safeHref(it.image)}' alt='' loading='lazy'/>`
            : `<div class='lb-sf-img lb-sf-noimg'></div>`;
          const price =
            it.price != null && String(it.price).trim()
              ? `<div class='lb-sf-price'>${esc(String(it.price))}</div>`
              : '';
          return (
            `<a class='lb-sf-card' href='${safeHref(it.href || '#')}'>` +
            img +
            `<div class='lb-sf-title'>${esc(String(it.title || ''))}</div>` +
            price +
            `<span class='lb-btn lb-sf-cta'>${esc(String(it.cta || 'Shop now'))}</span>` +
            `</a>`
          );
        })
        .join('');
      return `<section class='lb-storefront'><div class='lb-sf-grid'>${cards}</div></section>`;
    }
    case 'quiz_steps': {
      // Multi-step quiz. Questions are server-rendered (escaped); the runtime
      // (quizRuntimeScript) only toggles step visibility, records answers to
      // sessionStorage — NEVER the URL (no PII in query strings) — and
      // advances via the compiled flow when done.
      const questions = (Array.isArray(p.questions) ? p.questions : []).filter(
        isPlainObject
      );
      if (!questions.length) return `<!-- quiz_steps: no questions configured -->`;
      const steps = questions
        .map((qz, i) => {
          const opts = (Array.isArray(qz.options) ? qz.options : [])
            .map(
              (o) =>
                `<button type='button' class='lb-quiz-opt' data-fos-quiz-opt>${esc(String(o))}</button>`
            )
            .join('');
          return (
            `<div class='lb-quiz-step' data-fos-quiz-step='${i}'${i ? ' hidden' : ''}>` +
            `<div class='lb-quiz-q'>${esc(String(qz.question || ''))}</div>` +
            `<div class='lb-quiz-opts'>${opts}</div>` +
            `</div>`
          );
        })
        .join('');
      const finish = esc(String(p.finish_text || 'See my results'));
      const done = esc(String(p.done_text || 'All done! Your results are ready.'));
      return (
        `<section class='lb-quiz' data-fos-quiz data-fos-quiz-count='${questions.length}'>` +
        `<div class='lb-quiz-progress'><div class='lb-quiz-bar' data-fos-quiz-bar style='width:0%'></div></div>` +
        steps +
        `<div class='lb-quiz-done' data-fos-quiz-done hidden>` +
        `<div class='lb-quiz-q'>${done}</div>` +
        `<button type='button' class='lb-btn lb-quiz-finish' data-fos-quiz-finish>${finish}</button>` +
        `</div>` +
        `</section>`
      );
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
// Persist the created session id so downstream funnel steps (the 1-click
// upsell page, the thank-you page) can carry it after navigation — the base
// checkout holds the session only in memory, which does not survive a page
// change. Stored id ONLY (never a price): the upsell runtime re-reads the
// server-priced amount itself. Storage failures (private mode / disabled) are
// non-fatal — the id also rides the URL as ?s=.
function persistSession(session){try{if(session&&session.session_id){try{window.sessionStorage.setItem('__fos_session',session.session_id);}catch(e){}try{window.localStorage.setItem('__fos_session',session.session_id);}catch(e){}}}catch(e){}}
var whopLoaderStarted=false;
function loadWhopLoader(){if(whopLoaderStarted)return;whopLoaderStarted=true;var s=document.createElement('script');s.async=true;s.defer=true;s.src='https://js.whop.com/static/checkout/loader.js';(document.head||document.body).appendChild(s);}
function post(path,payload){return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload)}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,json:j};});});}
function sessErr(code){if(code==='pricing_unavailable')return 'Payment is temporarily unavailable. Please try again in a moment.';if(code==='invalid_variant'||code==='empty_cart')return 'This item is currently unavailable.';if(code==='total_below_minimum')return 'This order is below the minimum amount.';if(code==='rate_limited')return 'Too many attempts. Please wait a moment and retry.';return 'We could not start checkout ('+code+').';}
function embedErr(code){if(code==='gateway_not_configured')return 'Checkout is not fully set up yet. Please contact support.';if(code==='session_not_payable')return 'This checkout session has expired. Please refresh the page.';if(code==='gateway_error')return 'The payment provider is temporarily unavailable. Please try again shortly.';return 'We could not start the payment ('+code+').';}
function mountEmbed(root,embed){try{var mount=root.querySelector('[data-fos-whop-mount]');if(!mount||!embed.whop_session_id){return;}
/* The loader only reacts to nodes being ADDED — configuring a node it has
   already scanned does nothing, which is why setting the session attribute
   after the buyer filled the form left the iframe uncreated. Re-inserting the
   fully-configured node is what actually triggers it (verified live: 0 -> 1
   iframe the instant the node was replaced). */
function activate(){var fresh=mount.cloneNode(true);mount.parentNode.replaceChild(fresh,mount);mount=fresh;}
/* The embed ships a COMPLETE checkout of its own (dark, browser-locale, its own
   email + billing + price + TOS + CTA). Dropped into our page that is a second
   checkout inside the first. Reduce it to the ONE thing only it can do - the
   PCI card fields - and let our page own every other pixel. */
mount.setAttribute('data-whop-checkout-theme','light');
mount.setAttribute('data-whop-checkout-locale','en');
mount.setAttribute('data-whop-checkout-hide-email','true');
/* Whop's billing block duplicates our Delivery section, so hide it — but
   ONLY because we now bake the address into the iframe URL at creation
   (see gating below). Hiding a field we could not populate is exactly
   what made the first live order unsubmittable. */mount.setAttribute('data-whop-checkout-hide-address','true');
mount.setAttribute('data-whop-checkout-hide-price','true');
mount.setAttribute('data-whop-checkout-hide-tos','true');
mount.setAttribute('data-whop-checkout-hide-submit-button','true');
/* identifiedFrames is keyed by the mount's HTML id, not a data-* attribute, so
   wco.submit('puure-checkout') only resolves once this is set. */
if(!mount.id){mount.id='puure-checkout';}
/* THE EMAIL IS LOAD-BEARING. Whop cannot complete a charge without one, and we
   hid its field so the buyer can never supply or correct it there. wco.setEmail
   is NOT a fallback: with the field hidden the embed does not answer the
   messaging API at all (setEmail/getEmail both time out), so an email injected
   after mount never lands. It has to be in the iframe URL at creation, which
   means we must not mount until we actually have one. */
var placeholder=root.querySelector('[data-fos-whop-wait]');
var mounted=false;
function fieldValue(n){var el=document.querySelector('[name="'+n+'"]');return el?String(el.value||'').trim():'';}
function emailValue(){return fieldValue('email');}
/* Everything Whop's hidden billing block would have asked for, taken from the
   Delivery section the buyer already filled. Baked into the iframe URL at
   creation because the embed cannot be told anything after it mounts. */
function billing(){
  var name=(fieldValue('first_name')+' '+fieldValue('last_name')).trim();
  return {name:name,line1:fieldValue('address1'),line2:fieldValue('address2'),
          city:fieldValue('city'),state:fieldValue('state'),
          postal:fieldValue('postal'),country:fieldValue('country')};}
/* The address is REQUIRED once hidden — mounting without it recreates the
   invisible-failure bug. Gate on the minimum Whop needs to authorise a card. */
function billingReady(){var b=billing();return !!(b.name&&b.line1&&b.city&&b.postal&&b.country);}
function applyPrefill(b,v){
  mount.setAttribute('data-whop-checkout-prefill-email',v);
  mount.setAttribute('data-whop-checkout-prefill-name',b.name);
  mount.setAttribute('data-whop-checkout-prefill-address-line1',b.line1);
  if(b.line2){mount.setAttribute('data-whop-checkout-prefill-address-line2',b.line2);}
  mount.setAttribute('data-whop-checkout-prefill-address-city',b.city);
  if(b.state){mount.setAttribute('data-whop-checkout-prefill-address-state',b.state);}
  mount.setAttribute('data-whop-checkout-prefill-address-postal-code',b.postal);
  mount.setAttribute('data-whop-checkout-prefill-address-country',b.country);}
function prefillKey(){var b=billing();return emailValue()+'|'+b.name+'|'+b.line1+'|'+b.line2+'|'+b.city+'|'+b.state+'|'+b.postal+'|'+b.country;}
/* No regex here on purpose: this runtime is emitted through a template
   literal, which eats the backslashes — /^[^@\\s]+.../ reached the browser
   as /^[^@s]+.../ and rejected every address containing the letter s,
   which is why the first live order never mounted a payment form.
   Plain string checks cannot be mangled by an escaping layer. */function valid(v){if(!v||v.indexOf(' ')!==-1)return false;var at=v.indexOf('@');if(at<1||at!==v.lastIndexOf('@'))return false;var dot=v.lastIndexOf('.');return dot>at+1&&dot<v.length-1;}
function doMount(){var v=emailValue();if(mounted||!valid(v)||!billingReady()){return;}mounted=true;
  applyPrefill(billing(),v);
  mount.setAttribute('data-fos-prefill-key',prefillKey());
  mount.setAttribute('data-whop-checkout-session',embed.whop_session_id);
  /* Belt + braces with the plan's server-side redirect_url: also tell the
     EMBED where to send the buyer, so Whop's own default post-purchase
     page (wrong product, visitor locale) never wins. */
  if(embed.redirect_url){mount.setAttribute('data-whop-checkout-return-url',embed.redirect_url);}
  if(placeholder){placeholder.hidden=true;}
  loadWhopLoader();
  activate();}
/* If the buyer corrects the address after the form mounted, the baked-in value
   is stale - tear the frame down and rebuild it with the new one rather than
   charging a receipt to the wrong address. */
function remount(){var v=emailValue();if(!mounted||!valid(v)||!billingReady()){return;}
  var k=prefillKey();if(mount.getAttribute('data-fos-prefill-key')===k){return;}
  mount.removeAttribute('data-whop-checkout-session');
  applyPrefill(billing(),v);
  mount.setAttribute('data-fos-prefill-key',k);
  setTimeout(function(){mount.setAttribute('data-whop-checkout-session',embed.whop_session_id);activate();},50);}
['email','first_name','last_name','address1','address2','city','state','postal','country'].forEach(function(n){
  var el=document.querySelector('[name="'+n+'"]');if(!el){return;}
  el.addEventListener('blur',function(){mounted?remount():doMount();});
  el.addEventListener('change',function(){mounted?remount():doMount();});
  el.addEventListener('input',function(){if(!mounted){doMount();}});});
doMount();
var fb=root.querySelector('[data-fos-fallback]');if(fb&&embed.purchase_url){fb.setAttribute('href',embed.purchase_url);fb.hidden=false;}
}catch(e){showError(root,'Could not initialize the payment form.');}}

function initBlock(root){var cfg={};try{cfg=JSON.parse((root.querySelector('.fos-checkout-cfg')||{}).textContent||'{}');}catch(e){cfg={};}var items=(cfg&&cfg.line_items)||[];if(!items.length){showError(root,'This checkout has no product configured yet.');return;}
post('/create-session',{funnel_id:CTX.funnel_id,page_id:CTX.page_id,gateway:'whop',line_items:items}).then(function(res){if(res.status!==200||!res.json||!res.json.success){showError(root,sessErr((res.json&&res.json.error&&res.json.error.code)||('http_'+res.status)));return;}var session=res.json.data;window.__fos_checkout.session=session;persistSession(session);fillSummaries(session);return post('/whop/create-session',{session_id:session.session_id}).then(function(er){if(er.status!==200||!er.json||!er.json.success){showError(root,embedErr((er.json&&er.json.error&&er.json.error.code)||('http_'+er.status)));return;}var embed=er.json.data;if(!embed||!embed.whop_session_id){showError(root,'Checkout is not fully set up yet (no session).');return;}mountEmbed(root,embed);});}).catch(function(){showError(root,'Network error starting checkout. Please try again.');});}
ready(function(){try{var blocks=document.querySelectorAll('[data-fos-checkout]');if(!blocks.length){return;}Array.prototype.forEach.call(blocks,function(b){try{initBlock(b);}catch(e){}});}catch(e){}});
})();`;
  return `<script>window.__fos_checkout=Object.assign(window.__fos_checkout||{},${json});${body}</script>`;
}

// ---------------------------------------------------------------------------
// 1-CLICK UPSELL runtime (buyer-facing post-purchase offer page).
//
// Emitted ONCE per page, only when an upsell_offer block is present. It
// publishes window.__fos_upsell = { funnel_id, page_id, api_base } and drives
// every [data-fos-upsell] block through the EXISTING money path:
//
//  Session id — carried across the funnel (the base checkout only holds it in
//  memory): resolved from, in order, the ?s= URL param, the __fos_session
//  storage the base checkout wrote, then window.__fos_checkout.session.
//
//  Load    GET  {api_base}/upsell/offer?session_id&offer_id?&page_id
//          200 → { offer_id, variant_id, title, image, price, original_price,
//                  discount_pct, currency }   ← SERVER-priced, client never sends
//                  a price. 404 offer/session_not_found · 503 pricing_unavailable
//  Accept  POST {api_base}/upsell/accept  { session_id, offer_id, variant_id }
//          data.status ∈ settled | already_purchased | processing |
//                        requires_payment_method | requires_action | declined |
//                        needs_review        (see checkoutPublic.js contract)
//  Decline POST {api_base}/upsell/decline { session_id, offer_id }
//
// Money postures (mirror the checkout runtime):
//  • The client NEVER sends a trusted price. The amount charged is re-priced
//    server-side by /upsell/accept; the shown amount comes from /upsell/offer,
//    also server-side. A 2xx from accept is NOT proof money moved — only
//    'settled'/'already_purchased' advance immediately; 'processing' POLLS
//    (re-calling accept is idempotent — the unique (session,offer,slot) index
//    makes a repeat return 'processing', never a second charge) and never
//    advances on trust until it flips or a bounded timeout elapses (the charge
//    stays pending_settlement server-side; the webhook/sweep is the authority).
//  • XSS: the offer title is written with textContent, the image via a
//    scheme-checked setAttribute, the amount via textContent — a hostile offer
//    field is inert.
//  • Fail-visible: any load error shows an inline message and offers Decline so
//    the buyer is never stuck; the whole runtime is try/guarded.
// ---------------------------------------------------------------------------
function upsellRuntimeScript(ctx) {
  const json = jsonForScript({
    funnel_id: ctx.funnel_id != null ? String(ctx.funnel_id) : null,
    page_id: ctx.page_id != null ? String(ctx.page_id) : null,
    api_base: '/api/v1/checkout/public',
  });
  const body = `(function(){
var CTX=window.__fos_upsell;var API=(CTX&&CTX.api_base)||'/api/v1/checkout/public';
var POLL_MS=2500;var POLL_MAX=12;
function ready(fn){if(document.readyState!=='loading'){fn();}else{document.addEventListener('DOMContentLoaded',fn);}}
function money(n,c){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:(c||'USD')}).format(Number(n));}catch(e){return (c||'')+' '+Number(n||0).toFixed(2);}}
function sid(){try{var u=new URL(window.location.href);var q=u.searchParams.get('s')||u.searchParams.get('session')||u.searchParams.get('session_id');if(q)return q;}catch(e){}try{var s=window.sessionStorage.getItem('__fos_session');if(s)return s;}catch(e){}try{var l=window.localStorage.getItem('__fos_session');if(l)return l;}catch(e){}try{var m=window.__fos_checkout&&window.__fos_checkout.session;if(m&&m.session_id)return m.session_id;}catch(e){}return '';}
var SID=sid();
function flow(){return window.__fos_flow||{};}
function go(path){if(!path){return;}try{var u=new URL(path,window.location.origin);if(SID&&!u.searchParams.get('s'))u.searchParams.set('s',SID);window.location.assign(u.pathname+u.search+u.hash);}catch(e){try{window.location.assign(path);}catch(e2){}}}
function advanceMain(){var p=flow().next_path;if(p){go(p);return;}
/* R2: no main edge configured. A charged buyer must never be left on a
   spinner: show a clear confirmation instead of a dead-end. */
try{var s=document.querySelector('[data-fos-up-status-msg]');if(s)s.textContent='You are all set. Your order is confirmed.';var box=document.querySelector('[data-fos-up-status]');if(box)box.hidden=false;var a=document.querySelector('[data-fos-up-accept]');if(a)a.hidden=true;var d=document.querySelector('[data-fos-up-decline]');if(d)d.hidden=true;}catch(e){}}
function advanceDecline(){var f=flow();go(f.fallback_path||f.next_path);}
function q(root,sel){try{return root.querySelector(sel);}catch(e){return null;}}
function setText(root,sel,txt){var el=q(root,sel);if(el){el.textContent=txt;}}
function showError(root,msg){var e=q(root,'[data-fos-up-error]');if(e){e.hidden=false;e.textContent=msg;}}
function setStatus(root,msg,on){var s=q(root,'[data-fos-up-status]');var m=q(root,'[data-fos-up-status-msg]');if(m&&msg!=null)m.textContent=msg;if(s)s.hidden=!on;}
function setBusy(root,on){var a=q(root,'[data-fos-up-accept]');var d=q(root,'[data-fos-up-decline]');if(a)a.disabled=on;if(d)d.disabled=on;}
function post(path,payload){return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload)}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,json:j};});});}
function getJson(url){return fetch(url,{credentials:'same-origin'}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,json:j};});});}
function offerErr(code){if(code==='pricing_unavailable')return 'This offer is temporarily unavailable. Please continue.';if(code==='offer_not_found'||code==='invalid_variant')return 'No offer is available right now. Please continue.';if(code==='session_not_found')return 'We could not find your order. Please continue.';return 'This offer could not be loaded. Please continue.';}
function acceptErr(code){if(code==='session_not_paid')return 'Your original order is still being confirmed. Please try again in a moment.';if(code==='session_disputed'||code==='session_refunded')return 'This offer is no longer available on your order.';if(code==='pricing_unavailable')return 'This offer is temporarily unavailable. Please continue.';if(code==='rate_limited')return 'Too many attempts. Please wait a moment.';return 'We could not add this to your order ('+code+').';}
function fill(root,offer){try{
  setText(root,'[data-fos-up-title]',offer.title||'Special offer');
  var img=q(root,'[data-fos-up-image]');
  if(img&&offer.image&&/^https?:\\/\\//i.test(String(offer.image))){img.setAttribute('src',String(offer.image));img.hidden=false;}
  setText(root,'[data-fos-up-price]',money(offer.price,offer.currency));
  var orig=q(root,'[data-fos-up-original]');
  if(orig&&offer.original_price!=null&&Number(offer.original_price)>Number(offer.price)){orig.textContent=money(offer.original_price,offer.currency);orig.hidden=false;}
  var badge=q(root,'[data-fos-up-badge]');
  if(badge&&offer.discount_pct!=null&&Number(offer.discount_pct)>0){badge.textContent='Save '+Number(offer.discount_pct)+'%';badge.hidden=false;}
  root.setAttribute('data-offer-id',offer.offer_id||'');
  root.setAttribute('data-variant-id',offer.variant_id||'');
  var a=q(root,'[data-fos-up-accept]');if(a)a.disabled=false;
}catch(e){}}
function poll(root,tries){setStatus(root,'Finishing up your order…',true);
  post('/upsell/accept',{session_id:SID,offer_id:root.getAttribute('data-offer-id'),variant_id:root.getAttribute('data-variant-id')||undefined}).then(function(res){
    var d=(res.json&&res.json.data)||{};var st=d.status;
    if(st==='settled'||st==='already_purchased'){advanceMain();return;}
    if(st==='declined'||st==='requires_action'||st==='requires_payment_method'){advanceMain();return;}
    if(st==='processing'||st==='needs_review'){
      if(tries<POLL_MAX){setTimeout(function(){poll(root,tries+1);},POLL_MS);return;}
      // Bounded out — the charge is held server-side (pending_settlement); the
      // webhook/sweep settles it. Do not strand the buyer on this page.
      advanceMain();return;
    }
    advanceMain();
  }).catch(function(){ if(tries<POLL_MAX){setTimeout(function(){poll(root,tries+1);},POLL_MS);} else {advanceMain();} });
}
function onAccept(root){if(!SID){showError(root,'We could not find your order. Please continue.');return;}
  var oid=root.getAttribute('data-offer-id');if(!oid){showError(root,'No offer is available right now. Please continue.');return;}
  setBusy(root,true);setStatus(root,'Adding to your order…',true);
  post('/upsell/accept',{session_id:SID,offer_id:oid,variant_id:root.getAttribute('data-variant-id')||undefined}).then(function(res){
    if(res.status!==200||!res.json||!res.json.success){var c=(res.json&&res.json.error&&res.json.error.code)||('http_'+res.status);setStatus(root,null,false);setBusy(root,false);showError(root,acceptErr(c));return;}
    var d=res.json.data||{};var st=d.status;
    if(st==='settled'||st==='already_purchased'){advanceMain();return;}
    if(st==='requires_payment_method'){
      // 1-click impossible (base paid but no reusable saved method). A full
      // card re-entry lane is out of scope here — inform and advance so the
      // funnel is never dead-ended. (Integration point: mount a card-entry
      // fallback that re-collects a method, then re-POST /upsell/accept.)
      setStatus(root,null,false);showError(root,'We could not use your saved payment method for this one-click offer. Continuing to the next step.');setTimeout(advanceMain,1800);return;}
    if(st==='requires_action'){setStatus(root,null,false);showError(root,'This payment needs extra verification we cannot complete here. Continuing.');setTimeout(advanceMain,1800);return;}
    if(st==='declined'){setStatus(root,null,false);showError(root,'That payment was declined. Continuing to the next step.');setTimeout(advanceMain,1800);return;}
    if(st==='processing'||st==='needs_review'){poll(root,0);return;}
    advanceMain();
  }).catch(function(){setStatus(root,null,false);setBusy(root,false);showError(root,'Network error. Please try again.');});
}
function onDecline(root){setBusy(root,true);setStatus(root,'One moment…',true);
  post('/upsell/decline',{session_id:SID,offer_id:root.getAttribute('data-offer-id')||undefined}).then(function(){advanceDecline();}).catch(function(){advanceDecline();});}
function initBlock(root){
  var a=q(root,'[data-fos-up-accept]');var d=q(root,'[data-fos-up-decline]');
  if(a)a.addEventListener('click',function(){onAccept(root);});
  if(d)d.addEventListener('click',function(){onDecline(root);});
  var cfg={};try{cfg=JSON.parse((q(root,'.fos-upsell-cfg')||{}).textContent||'{}');}catch(e){cfg={};}
  if(!SID){showError(root,'We could not find your order.');setText(root,'[data-fos-up-title]','No offer available');return;}
  var url=API+'/upsell/offer?session_id='+encodeURIComponent(SID);
  if(cfg&&cfg.offer_id){url+='&offer_id='+encodeURIComponent(cfg.offer_id);}
  if(CTX&&CTX.page_id){url+='&page_id='+encodeURIComponent(CTX.page_id);}
  getJson(url).then(function(res){
    if(res.status!==200||!res.json||!res.json.success){setText(root,'[data-fos-up-title]','No offer available');showError(root,offerErr((res.json&&res.json.error&&res.json.error.code)||('http_'+res.status)));return;}
    fill(root,res.json.data);
  }).catch(function(){setText(root,'[data-fos-up-title]','No offer available');showError(root,'This offer could not be loaded. Please continue.');});
}
ready(function(){try{var blocks=document.querySelectorAll('[data-fos-upsell]');if(!blocks.length)return;Array.prototype.forEach.call(blocks,function(b){try{initBlock(b);}catch(e){}});}catch(e){}});
})();`;
  return `<script>window.__fos_upsell=Object.assign(window.__fos_upsell||{},${json});${body}</script>`;
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

  // 1-CLICK UPSELL: emit the upsell runtime ONLY when the page carries an
  // upsell_offer block. funnel_id/page_id thread into /upsell/offer so the
  // right offer resolves + prices server-side.
  const hasUpsell = blocks.some(
    (b) => isPlainObject(b) && UPSELL_RUNTIME_TYPES.has(b.type)
  );
  const upsellScript = hasUpsell
    ? upsellRuntimeScript({
        funnel_id: (funnel || {}).id ?? null,
        page_id: (page || {}).id ?? null,
      })
    : '';

  // PAGE-TYPES slice: thank-you / opt-in / quiz / countdown runtimes — each
  // emitted ONLY when its block type is present (same posture as checkout/
  // upsell above); pages without them stay byte-identical.
  const pageTypeScripts = pageTypeRuntimeScripts(blocks, funnel, page);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="same-origin" /><!-- R1: the ?s= session capability must never leak cross-origin via Referer -->

${trackingHeadScript({ funnel_id: (funnel || {}).id ?? null, page_id: (page || {}).id ?? null })}
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
${upsellScript}
${pageTypeScripts}
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
main{display:grid;grid-template-columns:minmax(0,1fr) 420px;column-gap:56px;row-gap:0;max-width:1180px;margin:0 auto;padding:0 24px 64px;align-items:start;}
main>.lb-blk{grid-column:1;min-width:0;margin:0 0 26px;}
main>[data-blk-id='ckt_summary']{grid-column:2;grid-row:1/span 40;margin:0;align-self:stretch;border-left:1px solid #e2e2e2;background:#f7f7f7;padding-left:36px;}
/* Brand */
.ckt-brand{text-align:center;padding:30px 0 4px;}
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
.lb-whop-wait{border:1.5px dashed #d8d8d8;border-radius:10px;padding:18px 16px;color:#6b7280;font-size:.95rem;text-align:center;background:#fafafa;margin:8px 0 16px;}
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
  /* Ship the buyer's contact + delivery details to the SESSION.
     The session is minted on page load, before anything is typed, so without
     this it stays empty and the Shopify order is created with no shipping and
     no billing address — exactly what the first real order showed. Sent as the
     buyer types (debounced) and again, awaited, immediately before submit so a
     fast click can never race it. */
  function fv(n){var el=document.querySelector('[name="'+n+'"]');return el?String(el.value||'').trim():'';}
  function customerPayload(){
    return {customer:{
      email:fv('email'), phone:fv('phone'),
      first_name:fv('first_name'), last_name:fv('last_name'),
      shipping:{address1:fv('address1'), address2:fv('address2'), city:fv('city'),
                state:fv('state'), zip:fv('postal'), country:fv('country')}}};}
  function sessionId(){try{return (window.__fos_checkout&&window.__fos_checkout.session||{}).session_id||'';}catch(e){return '';}}
  function syncCustomer(){var sid=sessionId();if(!sid){return Promise.resolve();}
    return fetch('/api/v1/checkout/public/session/'+encodeURIComponent(sid)+'/customer',
      {method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
       body:JSON.stringify(customerPayload())}).catch(function(){});}
  var syncTimer=null;
  function scheduleSync(){if(syncTimer){clearTimeout(syncTimer);}syncTimer=setTimeout(syncCustomer,600);}
  ['email','phone','first_name','last_name','address1','address2','city','state','postal','country']
    .forEach(function(n){var el=document.querySelector('[name="'+n+'"]');if(!el){return;}
      el.addEventListener('change',scheduleSync);el.addEventListener('blur',scheduleSync);});
  document.addEventListener('click',function(ev){
    var btn=ev.target&&ev.target.closest&&ev.target.closest('[data-ckt-complete]');
    if(!btn)return;
    try{
      var mount=q('[data-fos-whop-mount]');
      /* Whop's own CTA is hidden (it read "Get access" in the visitor's
         language). THIS button is the checkout's only submit, so it drives the
         embed through the loader's documented API. */
      var em=q('input[name="email"]');
      var emv=em?String(em.value||'').trim():'';
      /* The embed is only created once a valid email exists (it bakes the
         address into the iframe URL). Without one there is nothing to submit,
         so say so instead of spinning a button that can never succeed — the
         exact failure that silently swallowed the first live order. */
      var _at=emv.indexOf('@'),_dot=emv.lastIndexOf('.');
      var _okEmail=emv&&emv.indexOf(' ')===-1&&_at>0&&_at===emv.lastIndexOf('@')&&_dot>_at+1&&_dot<emv.length-1;
      if(!_okEmail){
        if(em){em.focus();em.scrollIntoView({behavior:'smooth',block:'center'});}
        return;
      }
      if(window.wco&&typeof window.wco.submit==='function'&&mount&&mount.getAttribute('data-whop-checkout-session')){
        btn.disabled=true;var prev=btn.textContent;btn.textContent='Processing\u2026';
        var settled=false;
        /* showError()/root live in the RUNTIME script's scope, not this one —
           calling them from here threw a ReferenceError and the buyer got a
           silently re-enabled button with no explanation. Talk to the error
           node directly. */
        var say=function(msg){try{var e=document.querySelector('[data-fos-error]');
          if(e){e.hidden=false;e.textContent=msg;e.scrollIntoView({behavior:'smooth',block:'center'});}}catch(e2){}};
        var done=function(msg){if(settled){return;}settled=true;btn.disabled=false;btn.textContent=prev;
          if(msg){say(msg);}};
        /* wco.submit is FIRE-AND-FORGET: it postMessages 'submit' into the frame
           and resolves undefined. The outcome arrives as 'complete' or
           'payment-error' events on the mount. A card that fails the embed's OWN
           validation raises NEITHER — it just renders a message inside the
           iframe — so a button that waits for an event sticks on 'Processing…'
           forever while the real error sits out of view. Re-enable quickly and
           point the buyer at the form instead of freezing. */
        try{
          mount.addEventListener('payment-error',function(ev){
            var d=ev&&ev.detail;done((d&&(d.message||d.error))||'That payment could not be completed. Please check your card details.');},{once:true});
          mount.addEventListener('complete',function(){settled=true;btn.textContent='Confirmed';},{once:true});
          if(mount.scrollIntoView){mount.scrollIntoView({behavior:'smooth',block:'center'});}
          /* Awaited: the order is built from the session, so the address must
             be stored BEFORE the charge settles. */
          syncCustomer().then(function(){window.wco.submit('puure-checkout');});
          setTimeout(function(){done('If your card details are incomplete, correct them above and try again.');},8000);
        }catch(e){done('Could not submit the payment form.');}
        return;
      }
      /* Embed not mounted (creds missing / network): fall back to the hosted
         Whop page rather than a dead button. */
      var fb=q('[data-fos-fallback]');
      var href=fb&&fb.getAttribute('href');
      if(href&&href!=='#'){window.open(href,'_blank','noopener');return;}
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
          /* 'Default Title' is Shopify's placeholder variant name for a product
   that has no real variants — it is not a bundle and must never be
   shown to a buyer as one. Only label a variant that actually names
   something (e.g. 'MyPuure Device + 6 Months Supply of Lifting Oil'). */var vt=String(it.title||'').trim();var meaningful=vt&&vt.toLowerCase()!=='default title'&&vt!==String(it.product_title||'');if(nameEl&&meaningful&&!nameEl.querySelector('.ckt-os-sub')){
            var sub=document.createElement('span');sub.className='ckt-os-sub';sub.textContent='bundle: '+vt;nameEl.appendChild(sub);
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
      `</section>`),
    {
      id: 'ckt_whop',
      type: 'whop_checkout',
      props: { block_name: 'checkout-payment', quantity: 1, button_text: 'Complete checkout' },
    },
    html('ckt_payfoot', 'checkout-payment-options',
      `<section class='ckt-section'>` +
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

// ---------------------------------------------------------------------------
// UPSELL PAGE TEMPLATE (1-click post-purchase offer).
//
// Default seed for a page created with type='upsell'. Buyer-facing LIGHT theme,
// consistent with the checkout template. A flat, valid blocks[] list so the
// canvas can reorder/remove pieces safely. The offer itself is the LIVE
// upsell_offer block (its runtime resolves + server-prices the bound offer);
// it ships with NO offer_id, so until the operator attaches an offer (POST
// /api/v1/checkout/upsells with page_id, OR set props.offer_id on the block)
// the runtime resolves the offer bound to this page/funnel, else shows a clean
// "no offer available" state and the page still serves 200 (fail-open).
// ---------------------------------------------------------------------------
const UPSELL_TEMPLATE_CSS = `/* Upsell template (seeded) — buyer-facing LIGHT theme */
body{background:#f6f7f9;color:#111827;}
main{max-width:600px;margin:0 auto;padding:40px 20px 64px;}
main>.lb-blk{margin:0 0 20px;}
.lb-upsell-progress{display:flex;align-items:center;justify-content:center;gap:8px;color:#16a34a;font-weight:600;font-size:.9rem;margin-bottom:8px;}
.lb-upsell-progress svg{display:block;}
.lb-upsell{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px 26px;box-shadow:0 10px 30px rgba(17,24,39,.06);}
.lb-upsell-headline{font-size:1.6rem;font-weight:800;line-height:1.2;color:#0f172a;text-align:center;margin-bottom:8px;}
.lb-upsell-sub{color:#6b7280;text-align:center;margin:0 0 20px;font-size:1rem;}
.lb-upsell-card{display:flex;gap:18px;align-items:center;border:1px solid #eef0f3;border-radius:12px;padding:16px;background:#fafbfc;margin-bottom:18px;}
.lb-upsell-media{flex:0 0 auto;}
.lb-upsell-img{width:96px;height:96px;object-fit:cover;border-radius:10px;border:1px solid #e5e7eb;display:block;background:#fff;}
.lb-upsell-info{flex:1;min-width:0;}
.lb-upsell-name{font-weight:700;font-size:1.15rem;color:#0f172a;line-height:1.3;margin-bottom:8px;}
.lb-upsell-pricing{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.lb-upsell-price{font-size:1.5rem;font-weight:800;color:#111827;}
.lb-upsell-original{color:#9ca3af;text-decoration:line-through;font-size:1.05rem;}
.lb-upsell-save{background:#dcfce7;color:#166534;border-radius:999px;padding:3px 10px;font-size:.78rem;font-weight:700;}
.lb-upsell-error{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:11px 14px;margin-bottom:14px;font-size:.95rem;}
.lb-upsell-actions{display:flex;flex-direction:column;gap:12px;}
.lb-upsell-accept{display:block;width:100%;background:#16a34a;color:#fff;border:0;border-radius:12px;padding:17px;font:800 1.1rem/1.2 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 16px rgba(22,163,74,.28);transition:background .15s,transform .05s;}
.lb-upsell-accept:hover:not(:disabled){background:#15803d;}
.lb-upsell-accept:active:not(:disabled){transform:translateY(1px);}
.lb-upsell-accept:disabled{background:#a7d7bb;cursor:not-allowed;box-shadow:none;}
.lb-upsell-decline{display:block;width:100%;background:transparent;color:#6b7280;border:0;padding:6px;font:500 .95rem/1.2 Inter,system-ui,sans-serif;cursor:pointer;text-decoration:underline;}
.lb-upsell-decline:hover:not(:disabled){color:#111827;}
.lb-upsell-decline:disabled{opacity:.5;cursor:not-allowed;}
.lb-upsell-status{display:flex;align-items:center;justify-content:center;gap:10px;color:#374151;font-size:.95rem;margin-top:14px;}
.lb-upsell-spinner{width:18px;height:18px;border:2px solid #d1d5db;border-top-color:#16a34a;border-radius:50%;display:inline-block;animation:lbupspin .7s linear infinite;}
@keyframes lbupspin{to{transform:rotate(360deg);}}
.lb-upsell-fine{color:#9ca3af;font-size:.8rem;line-height:1.5;text-align:center;margin:18px 4px 0;}
@media (max-width:520px){
  .lb-upsell-card{flex-direction:column;text-align:center;}
  .lb-upsell-pricing{justify-content:center;}
  .lb-upsell-headline{font-size:1.35rem;}
}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'upsell' page. Fresh
// objects per call (never a frozen constant) so one page's canvas edits can
// never alias another's seed.
export function upsellPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const blocks = [
    html('ups_progress', 'upsell-progress',
      `<div class='lb-upsell-progress'>` +
      `<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M20 6 9 17l-5-5'/></svg>` +
      `Payment confirmed — one quick thing before your receipt</div>`),
    {
      id: 'ups_offer',
      type: 'upsell_offer',
      props: {
        block_name: 'upsell-offer',
        headline: 'Wait — add this to your order at a one-time discount',
        subheadline:
          'Because you just ordered, you can add this now with a single click. ' +
          'No need to re-enter your payment or shipping details.',
        accept_text: 'Yes — add this to my order',
        decline_text: 'No thanks, I’ll pass on this one-time offer',
      },
    },
  ];
  return { blocks, custom_css: UPSELL_TEMPLATE_CSS, custom_js: '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE-TYPES slice (feat/page-types) — everything below is ADDITIVE.
// New page types: thankyou · downsell · optin · storefront · quiz · lead
// (advertorial preset). Each gets a seed template (funnels.js branches on
// page type at create) and, where interactive, a per-block-type runtime
// emitted by pageTypeRuntimeScripts() only when the block is present.
// NO new money code: the downsell reuses the upsell_offer block + runtime +
// /upsell/* endpoints untouched; the thank-you page reads the EXISTING
// GET /session/:id snapshot; the opt-in posts to routes/optinPublic.js
// (leads only, never money).
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// THANK-YOU runtime — fills [data-fos-order-summary] on the confirmation page
// from the EXISTING public session snapshot (GET /session/:id — hand-picked
// safe fields, already rate-limited server-side). Session id is carried into
// this page by the upsell runtime's go() as ?s= (with the same storage
// fallbacks). Fail-soft: no id / 404 / network error leaves the seeded empty
// state; nothing throws. All server text lands via textContent (XSS-inert).
// ---------------------------------------------------------------------------
function thankYouRuntimeScript(ctx) {
  const json = jsonForScript({
    funnel_id: ctx.funnel_id != null ? String(ctx.funnel_id) : null,
    page_id: ctx.page_id != null ? String(ctx.page_id) : null,
    api_base: '/api/v1/checkout/public',
  });
  const body = `(function(){
var CTX=window.__fos_thankyou;var API=(CTX&&CTX.api_base)||'/api/v1/checkout/public';
function ready(fn){if(document.readyState!=='loading'){fn();}else{document.addEventListener('DOMContentLoaded',fn);}}
function money(n,c){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:(c||'USD')}).format(Number(n));}catch(e){return (c||'')+' '+Number(n||0).toFixed(2);}}
function sid(){try{var u=new URL(window.location.href);var q=u.searchParams.get('s')||u.searchParams.get('session')||u.searchParams.get('session_id');if(q)return q;}catch(e){}try{var s=window.sessionStorage.getItem('__fos_session');if(s)return s;}catch(e){}try{var l=window.localStorage.getItem('__fos_session');if(l)return l;}catch(e){}return '';}
function row(label,value,cls){var d=document.createElement('div');d.className='fos-os-row'+(cls?(' '+cls):'');var a=document.createElement('span');a.className='fos-os-name';a.textContent=label;var b=document.createElement('span');b.className='fos-os-price';b.textContent=value;d.appendChild(a);d.appendChild(b);return d;}
function fill(session){try{var nodes=document.querySelectorAll('[data-fos-order-summary]');Array.prototype.forEach.call(nodes,function(node){try{node.innerHTML='';var cur=session.currency;(session.line_items||[]).forEach(function(li){var qn=Number(li.quantity||1);var name=(li.product_title||li.title||'Item')+((qn>1)?(' \\u00d7 '+qn):'');var lt=Number(li.price||0)*qn;node.appendChild(row(name,money(lt,cur)));});var t=(session.totals||{});if(t.subtotal!=null){node.appendChild(row('Subtotal',money(t.subtotal,cur)));}if(t.shipping!=null&&Number(t.shipping)>0){node.appendChild(row('Shipping',money(t.shipping,cur)));}node.appendChild(row('Total',money(t.total!=null?t.total:0,cur),'fos-os-total'));}catch(e){}});}catch(e){}}
/* Buyer-safe pending state: rewrite the confirmation copy and clear any
   summary node so an unsettled session never reads as "order confirmed". */
function pending(st){try{var h=document.querySelector('[data-fos-thankyou-title]')||document.querySelector('h1');if(h){h.textContent='Your payment is still processing';}
var n=document.querySelector('[data-fos-thankyou-note]');if(n){n.textContent='We have not received confirmation for this order yet. This page will show your receipt once the payment settles. No further action is needed.';}
Array.prototype.forEach.call(document.querySelectorAll('[data-fos-order-summary]'),function(node){node.innerHTML='';});}catch(e){}}
ready(function(){try{
var SID=sid();if(!SID){return;}
fetch(API+'/session/'+encodeURIComponent(SID),{credentials:'same-origin'}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,json:j};});}).then(function(res){if(res.status!==200||!res.json||!res.json.success||!res.json.data){return;}var d=res.json.data;
/* processing !== paid: a session that has not settled must NEVER render as a
   confirmed order on a buyer surface. Show a pending state instead. */
if(d.status!=='paid'&&d.status!=='deposit_paid'){pending(d.status);return;}
fill(d);}).catch(function(){});
}catch(e){}});
})();`;
  return `<script>window.__fos_thankyou=Object.assign(window.__fos_thankyou||{},${json});${body}</script>`;
}

// ---------------------------------------------------------------------------
// OPT-IN runtime — drives every [data-fos-optin] form: client-side email
// check, POST to the opt-in public intake (routes/optinPublic.js — leads
// table only, never money), honeypot passthrough, then advance via the
// compiled flow next_path (carrying ?s= like the upsell runtime so a mid-
// funnel opt-in never drops the session). Fail-visible on errors; the buyer
// is never stuck (no next_path ⇒ the success message simply stays).
// ---------------------------------------------------------------------------
function optinRuntimeScript(ctx) {
  const json = jsonForScript({
    funnel_id: ctx.funnel_id != null ? String(ctx.funnel_id) : null,
    page_id: ctx.page_id != null ? String(ctx.page_id) : null,
    api_base: '/api/v1/optin/public',
  });
  const body = `(function(){
var CTX=window.__fos_optin;var API=(CTX&&CTX.api_base)||'/api/v1/optin/public';
function ready(fn){if(document.readyState!=='loading'){fn();}else{document.addEventListener('DOMContentLoaded',fn);}}
function sid(){try{var u=new URL(window.location.href);var q=u.searchParams.get('s');if(q)return q;}catch(e){}try{var s=window.sessionStorage.getItem('__fos_session');if(s)return s;}catch(e){}return '';}
function go(path){if(!path)return false;try{var u=new URL(path,window.location.origin);var S=sid();if(S&&!u.searchParams.get('s'))u.searchParams.set('s',S);window.location.assign(u.pathname+u.search+u.hash);}catch(e){try{window.location.assign(path);}catch(e2){}}return true;}
function showErr(root,msg){var e=root.querySelector('[data-fos-optin-error]');if(e){e.hidden=false;e.textContent=msg;}}
function hideErr(root){var e=root.querySelector('[data-fos-optin-error]');if(e){e.hidden=true;}}
function submitErr(code){if(code==='invalid_email')return 'Please enter a valid email address.';if(code==='rate_limited')return 'Too many attempts. Please wait a moment and try again.';return 'Something went wrong. Please try again.';}
function initForm(root){root.addEventListener('submit',function(ev){ev.preventDefault();try{
hideErr(root);
var emailEl=root.querySelector('input[name=email]');var nameEl=root.querySelector('input[name=name]');var hpEl=root.querySelector('input[name=website]');var btn=root.querySelector('[data-fos-optin-submit]');
var email=(emailEl&&emailEl.value||'').trim();
if(!email||email.indexOf('@')<1||email.indexOf('.')<0){showErr(root,'Please enter a valid email address.');return;}
if(btn){btn.disabled=true;}
fetch(API+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({funnel_id:CTX&&CTX.funnel_id,page_id:CTX&&CTX.page_id,email:email,name:(nameEl&&nameEl.value||'').trim(),website:(hpEl&&hpEl.value||'')})}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,json:j};});}).then(function(res){
if((res.status===200||res.status===201)&&res.json&&res.json.success){var ok=root.querySelector('[data-fos-optin-success]');if(ok){ok.hidden=false;}var F=window.__fos_flow||{};setTimeout(function(){go(F.next_path);},600);return;}
if(btn){btn.disabled=false;}
showErr(root,submitErr((res.json&&res.json.error&&res.json.error.code)||('http_'+res.status)));
}).catch(function(){if(btn){btn.disabled=false;}showErr(root,'Network error. Please try again.');});
}catch(e){}});}
ready(function(){try{var forms=document.querySelectorAll('[data-fos-optin]');Array.prototype.forEach.call(forms,function(f){try{initForm(f);}catch(e){}});}catch(e){}});
})();`;
  return `<script>window.__fos_optin=Object.assign(window.__fos_optin||{},${json});${body}</script>`;
}

// ---------------------------------------------------------------------------
// QUIZ runtime — step visibility + progress bar for [data-fos-quiz]. Answers
// go to sessionStorage ('__fos_quiz_answers') ONLY — never the URL (no PII in
// query strings; the flow advance carries just the opaque ?s= session id like
// every other step). Finish → flow next_path. Fully guarded.
// ---------------------------------------------------------------------------
function quizRuntimeScript() {
  const body = `(function(){
function ready(fn){if(document.readyState!=='loading'){fn();}else{document.addEventListener('DOMContentLoaded',fn);}}
function sid(){try{var u=new URL(window.location.href);var q=u.searchParams.get('s');if(q)return q;}catch(e){}try{var s=window.sessionStorage.getItem('__fos_session');if(s)return s;}catch(e){}return '';}
function go(path){if(!path)return;try{var u=new URL(path,window.location.origin);var S=sid();if(S&&!u.searchParams.get('s'))u.searchParams.set('s',S);window.location.assign(u.pathname+u.search+u.hash);}catch(e){try{window.location.assign(path);}catch(e2){}}}
function save(answers){try{window.sessionStorage.setItem('__fos_quiz_answers',JSON.stringify(answers));}catch(e){}}
function initQuiz(root){try{
var steps=root.querySelectorAll('[data-fos-quiz-step]');var total=steps.length;if(!total)return;
var bar=root.querySelector('[data-fos-quiz-bar]');var done=root.querySelector('[data-fos-quiz-done]');
var answers={};var idx=0;
function setBar(){if(bar){bar.style.width=Math.round((Math.min(idx,total)/total)*100)+'%';}}
function show(i){Array.prototype.forEach.call(steps,function(s,k){s.hidden=(k!==i);});if(done)done.hidden=(i<total);if(i>=total){Array.prototype.forEach.call(steps,function(s){s.hidden=true;});if(done)done.hidden=false;}setBar();}
Array.prototype.forEach.call(steps,function(step,k){
var opts=step.querySelectorAll('[data-fos-quiz-opt]');
Array.prototype.forEach.call(opts,function(btn){btn.addEventListener('click',function(){try{
answers['q'+k]=btn.textContent||'';save(answers);idx=k+1;show(idx);
}catch(e){}});});});
var fin=root.querySelector('[data-fos-quiz-finish]');
if(fin){fin.addEventListener('click',function(){try{save(answers);var F=window.__fos_flow||{};go(F.next_path);}catch(e){}});}
show(0);
}catch(e){}}
ready(function(){try{var qs=document.querySelectorAll('[data-fos-quiz]');Array.prototype.forEach.call(qs,function(q){try{initQuiz(q);}catch(e){}});}catch(e){}});
})();`;
  return `<script>${body}</script>`;
}

// ---------------------------------------------------------------------------
// COUNTDOWN runtime — makes the (pre-existing, previously static) countdown
// block tick. Reads data-deadline (any Date-parseable string); an invalid or
// absent deadline leaves the static placeholder untouched. When expired it
// shows the block's optional data-expired attribute text, else a default.
// Additive: emitted only when a countdown block is on the page.
// ---------------------------------------------------------------------------
function countdownRuntimeScript() {
  const body = `(function(){
function ready(fn){if(document.readyState!=='loading'){fn();}else{document.addEventListener('DOMContentLoaded',fn);}}
function pad(n){return (n<10?'0':'')+n;}
ready(function(){try{
var nodes=document.querySelectorAll('.lb-countdown[data-deadline]');if(!nodes.length)return;
function tick(){Array.prototype.forEach.call(nodes,function(node){try{
var raw=node.getAttribute('data-deadline');if(!raw)return;
var end=Date.parse(raw);if(!isFinite(end))return;
var clock=node.querySelector('[data-el=clock]');if(!clock)return;
var ms=end-Date.now();
if(ms<=0){clock.textContent=node.getAttribute('data-expired')||'Offer expired';return;}
var s=Math.floor(ms/1000);var d=Math.floor(s/86400);var h=Math.floor((s%86400)/3600);var m=Math.floor((s%3600)/60);var ss=s%60;
clock.textContent=(d>0?(d+'d '):'')+pad(h)+':'+pad(m)+':'+pad(ss);
}catch(e){}});}
tick();setInterval(tick,1000);
}catch(e){}});
})();`;
  return `<script>${body}</script>`;
}

// Block-type → runtime map for the new page types. Called from renderPageHtml;
// returns '' for pages carrying none of these blocks (byte-identical output).
function pageTypeRuntimeScripts(blocks, funnel, page) {
  try {
    const list = Array.isArray(blocks) ? blocks : [];
    const has = (t) => list.some((b) => isPlainObject(b) && b.type === t);
    const ctx = {
      funnel_id: (funnel || {}).id ?? null,
      page_id: (page || {}).id ?? null,
    };
    let out = '';
    if (has('order_confirmation')) out += thankYouRuntimeScript(ctx);
    if (has('optin_form')) out += optinRuntimeScript(ctx);
    if (has('quiz_steps')) out += quizRuntimeScript();
    if (has('countdown')) out += countdownRuntimeScript();
    return out;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// THANK-YOU PAGE TEMPLATE — type='thankyou'. The funnel END NODE: no forward
// flow required. Light buyer theme consistent with checkout/upsell. The order
// recap is the order_confirmation block (existing GET /session/:id, above).
// ---------------------------------------------------------------------------
const TKY_TEMPLATE_CSS = `/* Thank-you template (seeded) — buyer-facing LIGHT theme */
body{background:#f6f7f9;color:#111827;}
main{max-width:640px;margin:0 auto;padding:40px 20px 64px;}
main>.lb-blk{margin:0 0 20px;}
.tky-hero{text-align:center;padding:8px 0 4px;}
.tky-check{width:64px;height:64px;border-radius:999px;background:#dcfce7;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;}
.tky-check svg{display:block;}
.tky-h1{font-size:1.8rem;font-weight:800;color:#0f172a;margin:0 0 8px;line-height:1.2;}
.tky-sub{color:#6b7280;margin:0;font-size:1.02rem;}
.lb-orderconf{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(17,24,39,.05);}
.lb-orderconf-title{font-size:1.1rem;margin:0 0 10px;}
.lb-orderconf-note{color:#9ca3af;font-size:.85rem;margin:14px 0 0;}
.tky-card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;}
.tky-card h3{font-size:1.1rem;margin:0 0 14px;}
.tky-steps{list-style:none;counter-reset:tky;margin:0;padding:0;}
.tky-steps li{counter-increment:tky;display:flex;gap:14px;align-items:flex-start;padding:10px 0;}
.tky-steps li::before{content:counter(tky);flex:0 0 28px;height:28px;border-radius:999px;background:#eff3fe;color:#2563eb;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-size:.9rem;}
.tky-step-title{font-weight:600;color:#0f172a;}
.tky-step-sub{color:#6b7280;font-size:.9rem;}
.tky-support{text-align:center;color:#6b7280;font-size:.95rem;}
.tky-support a{color:#2563eb;font-weight:600;}
.tky-continue-wrap{text-align:center;}
.tky-continue{padding:14px 34px;font-weight:700;}
@media (max-width:520px){.tky-h1{font-size:1.45rem;}}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'thankyou' page.
// Fresh objects per call so one page's canvas edits never alias another's seed.
export function thankYouPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const blocks = [
    html('tky_hero', 'thankyou-hero',
      `<header class='tky-hero'>` +
      `<span class='tky-check'><svg width='30' height='30' viewBox='0 0 24 24' fill='none' stroke='#16a34a' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M20 6 9 17l-5-5'/></svg></span>` +
      `<h1 class='tky-h1'>Thank you! Your order is confirmed.</h1>` +
      `<p class='tky-sub'>We are getting it ready to ship. You will receive a confirmation email shortly.</p>` +
      `</header>`),
    {
      id: 'tky_summary',
      type: 'order_confirmation',
      props: {
        block_name: 'thankyou-order-summary',
        title: 'Order summary',
        note: 'A confirmation email with your receipt is on its way to your inbox.',
      },
    },
    html('tky_next', 'thankyou-next-steps',
      `<section class='tky-card'><h3>What happens next</h3><ol class='tky-steps'>` +
      `<li><span><span class='tky-step-title'>Confirmation email</span><br/><span class='tky-step-sub'>Your receipt and order details arrive in your inbox within a few minutes.</span></span></li>` +
      `<li><span><span class='tky-step-title'>We pack your order</span><br/><span class='tky-step-sub'>Your order is prepared and handed to the carrier within 1 business day.</span></span></li>` +
      `<li><span><span class='tky-step-title'>Tracking on the way</span><br/><span class='tky-step-sub'>As soon as it ships, your tracking number lands in your inbox.</span></span></li>` +
      `</ol></section>`),
    html('tky_support', 'thankyou-support',
      `<p class='tky-support'>Questions about your order? Email <a href='mailto:support@trypuure.co'>support@trypuure.co</a> and we will be happy to help.</p>`),
    html('tky_continue', 'thankyou-continue',
      `<div class='tky-continue-wrap'><a class='lb-btn tky-continue' href='https://trypuure.co'>Back to the store</a></div>`),
  ];
  return { blocks, custom_css: TKY_TEMPLATE_CSS, custom_js: '' };
}

// ---------------------------------------------------------------------------
// DOWNSELL PAGE TEMPLATE — type='downsell'. STRUCTURALLY the upsell page: the
// same LIVE upsell_offer block + upsellRuntimeScript + EXISTING /upsell/offer,
// /upsell/accept, /upsell/decline endpoints, untouched (a downsell IS an
// upsell offer shown after a decline, typically smaller). Only the seeded
// copy differs. ZERO new charging code. The operator binds a cheaper offer to
// THIS page (co_upsells.page_id) so /upsell/offer resolves the downsell offer.
// ---------------------------------------------------------------------------
const DOWNSELL_EXTRA_CSS = `
/* Downsell variant */
/* The base upsell CSS sets display:flex on the status row, which overrides
   the [hidden] attribute's UA display:none — restore it so the Processing
   spinner only shows while a click is in flight. */
.lb-upsell-status[hidden]{display:none;}
.lb-dsl-banner{color:#b45309;}
.lb-upsell-accept{background:#2563eb;box-shadow:0 6px 16px rgba(37,99,235,.28);}
.lb-upsell-accept:hover:not(:disabled){background:#1d4ed8;}
.lb-upsell-accept:disabled{background:#a5bdf3;}
.lb-upsell-spinner{border-top-color:#2563eb;}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'downsell' page.
export function downsellPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const blocks = [
    html('dsl_banner', 'downsell-banner',
      `<div class='lb-upsell-progress lb-dsl-banner'>` +
      `<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><circle cx='12' cy='12' r='10'/><path d='M12 6v6l4 2'/></svg>` +
      `Hold on, we saved one smaller deal for you</div>`),
    {
      id: 'dsl_offer',
      type: 'upsell_offer',
      props: {
        block_name: 'downsell-offer',
        headline: 'Wait! Grab this lighter option before you finish',
        subheadline:
          'Not ready for the full upgrade? Add this smaller option to your order with one click. ' +
          'No need to re-enter your payment or shipping details.',
        accept_text: 'Yes, add this smaller deal',
        decline_text: 'No thanks, complete my order',
        fine_print:
          'This is a one-time charge to the payment method from your original order, not a subscription. ' +
          'By clicking, you authorize the charge shown above.',
      },
    },
  ];
  return {
    blocks,
    custom_css: UPSELL_TEMPLATE_CSS + DOWNSELL_EXTRA_CSS,
    custom_js: '',
  };
}

// ---------------------------------------------------------------------------
// OPT-IN PAGE TEMPLATE — type='optin'. Blank light page: headline, supporting
// text, the optin_form block (posts to routes/optinPublic.js), fine print.
// After submit the runtime advances via flow next_path.
// ---------------------------------------------------------------------------
const OPT_TEMPLATE_CSS = `/* Opt-in template (seeded) — buyer-facing LIGHT theme */
body{background:#f6f7f9;color:#111827;}
main{max-width:520px;margin:0 auto;padding:56px 20px 64px;}
main>.lb-blk{margin:0 0 18px;}
.opt-head{text-align:center;}
.opt-h1{font-size:1.9rem;font-weight:800;color:#0f172a;margin:0 0 10px;line-height:1.2;}
.opt-sub{color:#6b7280;margin:0;font-size:1.02rem;}
.lb-optin{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:26px;box-shadow:0 10px 30px rgba(17,24,39,.06);}
.lb-optin-headline{font-weight:700;font-size:1.05rem;color:#0f172a;margin-bottom:14px;text-align:center;}
.lb-optin-field{margin-bottom:12px;}
.lb-optin-input{width:100%;box-sizing:border-box;border:1.5px solid #cfcfcf;border-radius:10px;padding:15px 14px;font:400 16px/1.3 Inter,system-ui,sans-serif;color:#111;background:#fff;}
.lb-optin-input:focus{outline:2px solid rgba(37,99,235,.2);border-color:#2563eb;}
.lb-optin-hp{position:absolute;left:-9999px;top:-9999px;height:0;width:0;overflow:hidden;}
.lb-optin-error{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:.92rem;}
.lb-optin-success{color:#166534;background:#dcfce7;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:.95rem;font-weight:600;text-align:center;}
.lb-optin-submit{display:block;width:100%;background:#2563eb;color:#fff;border:0;border-radius:12px;padding:16px;font:800 1.05rem/1.2 Inter,system-ui,sans-serif;cursor:pointer;}
.lb-optin-submit:hover:not(:disabled){background:#1d4ed8;}
.lb-optin-submit:disabled{background:#a5bdf3;cursor:not-allowed;}
.opt-fine{text-align:center;color:#9ca3af;font-size:.82rem;}
@media (max-width:520px){.opt-h1{font-size:1.5rem;}}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'optin' page.
export function optinPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const blocks = [
    html('opt_head', 'optin-headline',
      `<header class='opt-head'><h1 class='opt-h1'>Unlock 10% off your first order</h1>` +
      `<p class='opt-sub'>Join the Puure list and we will send your discount code right away.</p></header>`),
    {
      id: 'opt_form',
      type: 'optin_form',
      props: {
        block_name: 'optin-form',
        button_text: 'Get my code',
        success_text: 'You are in! Check your inbox for your code.',
      },
    },
    html('opt_fine', 'optin-fine-print',
      `<p class='opt-fine'>No spam, ever. Unsubscribe anytime with one click.</p>`),
  ];
  return { blocks, custom_css: OPT_TEMPLATE_CSS, custom_js: '' };
}

// ---------------------------------------------------------------------------
// STOREFRONT PAGE TEMPLATE — type='storefront'. Grid of operator-configured
// product cards (storefront_grid block: image/title/price display string/
// href per card). Server-rendered, XSS-safe; no live Shopify fetch in v1.
// ---------------------------------------------------------------------------
const SFR_TEMPLATE_CSS = `/* Storefront template (seeded) — buyer-facing LIGHT theme */
body{background:#fff;color:#111827;}
main{max-width:1100px;margin:0 auto;padding:40px 20px 64px;}
main>.lb-blk{margin:0 0 24px;}
.sfr-head{text-align:center;padding:8px 0 4px;}
.sfr-h1{font-size:2rem;font-weight:800;color:#0f172a;margin:0 0 8px;}
.sfr-sub{color:#6b7280;margin:0;}
.lb-sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px;}
.lb-sf-card{display:flex;flex-direction:column;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;color:inherit;text-align:center;transition:box-shadow .15s;}
.lb-sf-card:hover{box-shadow:0 10px 30px rgba(17,24,39,.08);}
.lb-sf-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:#f3f4f6;display:block;}
.lb-sf-noimg{border:1px dashed #d1d5db;}
.lb-sf-title{font-weight:700;color:#0f172a;line-height:1.3;}
.lb-sf-price{font-weight:800;color:#111827;font-size:1.1rem;}
.lb-sf-cta{margin-top:auto;}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'storefront' page.
export function storefrontPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const card = (n) => ({
    title: `Product ${n}`,
    price: '$0.00',
    image: '',
    href: '#',
    cta: 'Shop now',
  });
  const blocks = [
    html('sfr_head', 'storefront-heading',
      `<header class='sfr-head'><h1 class='sfr-h1'>Shop Puure</h1>` +
      `<p class='sfr-sub'>Choose the option that fits you best.</p></header>`),
    {
      id: 'sfr_grid',
      type: 'storefront_grid',
      props: {
        block_name: 'storefront-grid',
        items: [card(1), card(2), card(3)],
      },
    },
  ];
  return { blocks, custom_css: SFR_TEMPLATE_CSS, custom_js: '' };
}

// ---------------------------------------------------------------------------
// QUIZ PAGE TEMPLATE — type='quiz'. Multi-step questions (quiz_steps block),
// progress bar, answers in sessionStorage (never the URL), final step
// advances via flow next_path.
// ---------------------------------------------------------------------------
const QZ_TEMPLATE_CSS = `/* Quiz template (seeded) — buyer-facing LIGHT theme */
body{background:#f6f7f9;color:#111827;}
main{max-width:560px;margin:0 auto;padding:48px 20px 64px;}
main>.lb-blk{margin:0 0 18px;}
.qz-head{text-align:center;}
.qz-h1{font-size:1.7rem;font-weight:800;color:#0f172a;margin:0 0 8px;line-height:1.2;}
.qz-sub{color:#6b7280;margin:0;}
.lb-quiz{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:26px;box-shadow:0 10px 30px rgba(17,24,39,.06);}
.lb-quiz-progress{height:8px;border-radius:999px;background:#eef0f3;overflow:hidden;margin-bottom:22px;}
.lb-quiz-bar{height:100%;background:#2563eb;border-radius:999px;transition:width .25s;}
.lb-quiz-q{font-weight:700;font-size:1.15rem;color:#0f172a;margin-bottom:16px;text-align:center;}
.lb-quiz-opts{display:flex;flex-direction:column;gap:10px;}
.lb-quiz-opt{display:block;width:100%;text-align:left;background:#fff;border:1.5px solid #d7dbe2;border-radius:12px;padding:15px 16px;font:600 1rem/1.3 Inter,system-ui,sans-serif;color:#111827;cursor:pointer;transition:border-color .12s,background .12s;}
.lb-quiz-opt:hover{border-color:#2563eb;background:#eff3fe;}
.lb-quiz-done{text-align:center;}
.lb-quiz-finish{display:inline-block;padding:15px 34px;font-weight:800;cursor:pointer;border:0;font-size:1.02rem;}
@media (max-width:520px){.qz-h1{font-size:1.4rem;}}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'quiz' page.
export function quizPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const blocks = [
    html('qz_head', 'quiz-heading',
      `<header class='qz-head'><h1 class='qz-h1'>Find your perfect match</h1>` +
      `<p class='qz-sub'>Answer 3 quick questions and we will point you to the right option.</p></header>`),
    {
      id: 'qz_steps',
      type: 'quiz_steps',
      props: {
        block_name: 'quiz-questions',
        questions: [
          {
            question: 'What is your main goal?',
            options: ['A firmer, lifted look', 'Daily comfort and support', 'Overall wellness'],
          },
          {
            question: 'How often would you use it?',
            options: ['Every day', 'A few times a week', 'Not sure yet'],
          },
          {
            question: 'Have you tried anything similar before?',
            options: ['Yes', 'No, this would be my first'],
          },
        ],
        done_text: 'All done! Your personalized pick is ready.',
        finish_text: 'See my recommendation',
      },
    },
  ];
  return { blocks, custom_css: QZ_TEMPLATE_CSS, custom_js: '' };
}

// ---------------------------------------------------------------------------
// ADVERTORIAL PAGE TEMPLATE — seeded for type='lead' (the palette's Lead /
// Advertorial page). Long-form article built almost entirely from EXISTING
// generic blocks (heading/text/image/checklist/testimonial/button) — a
// seeded-blocks preset, minimal new code. CTA advances via #fos-next.
// ---------------------------------------------------------------------------
const ADV_TEMPLATE_CSS = `/* Advertorial template (seeded) — buyer-facing LIGHT theme */
body{background:#fff;color:#374151;}
main{max-width:720px;margin:0 auto;padding:40px 22px 64px;}
main>.lb-blk{margin:0 0 22px;}
.adv-kicker{text-transform:uppercase;letter-spacing:.08em;font-size:.78rem;font-weight:700;color:#2563eb;text-align:center;}
.lb-heading{text-align:center;}
.adv-byline{text-align:center;color:#9ca3af;font-size:.85rem;}
.lb-text p{font-size:1.05rem;line-height:1.75;}
.lb-image img{border-radius:14px;}
.adv-cta-wrap{text-align:center;padding:8px 0;}
.adv-cta{padding:16px 38px;font-weight:800;font-size:1.05rem;}
@media (max-width:520px){h1.lb-heading{font-size:1.6rem;}}`;

// Returns { blocks, custom_css, custom_js } for a fresh 'lead' (advertorial)
// page.
export function advertorialPageTemplate() {
  const html = (id, name, markup) => ({
    id,
    type: 'html',
    props: { block_name: name, html: markup },
  });
  const blocks = [
    html('adv_kicker', 'advertorial-kicker',
      `<div class='adv-kicker'>Health and Beauty</div>`),
    {
      id: 'adv_headline',
      type: 'heading',
      props: {
        block_name: 'advertorial-headline',
        level: 1,
        text: 'Why thousands of women are switching to this simple at-home routine',
      },
    },
    html('adv_byline', 'advertorial-byline',
      `<div class='adv-byline'>By the Puure editorial team</div>`),
    {
      id: 'adv_intro',
      type: 'text',
      props: {
        block_name: 'advertorial-intro',
        html:
          `<p>Most of us have tried the creams, the workouts and the endless tips that promise results and never quite deliver. ` +
          `So when a simple routine started winning over thousands of loyal fans, we had to take a closer look.</p>` +
          `<p>Here is what we found, and why it might be the easiest change you make this year.</p>`,
      },
    },
    {
      id: 'adv_image',
      type: 'image',
      props: { block_name: 'advertorial-image', src: '', alt: '' },
    },
    {
      id: 'adv_points',
      type: 'checklist',
      props: {
        block_name: 'advertorial-points',
        items: [
          'Takes minutes a day, at home',
          'No harsh ingredients or complicated steps',
          'Loved by thousands of happy customers',
        ],
      },
    },
    // NOTE: deliberately NOT the native testimonial block — its renderer
    // hardcodes an em-dash before the author, and the em-dash ban covers
    // Puure buyer-facing copy. Same visual via the lb-quote class.
    html('adv_quote', 'advertorial-quote',
      `<blockquote class='lb-quote'>` +
      `<p>I noticed a difference within weeks. It is now part of my morning routine and I would not go back.</p>` +
      `<footer>Verified customer</footer>` +
      `</blockquote>`),
    {
      id: 'adv_more',
      type: 'text',
      props: {
        block_name: 'advertorial-body',
        html:
          `<p>The best part? You can try it today and see for yourself. ` +
          `Availability is limited, so if you have been waiting for a sign, this is it.</p>`,
      },
    },
    html('adv_cta', 'advertorial-cta',
      `<div class='adv-cta-wrap'><a class='lb-btn adv-cta' href='#fos-next'>See if it is right for you</a></div>`),
  ];
  return { blocks, custom_css: ADV_TEMPLATE_CSS, custom_js: '' };
}

export default {
  renderPageHtml,
  renderBlock,
  escapeHtml,
  compileFlow,
  checkoutPageTemplate,
  upsellPageTemplate,
  thankYouPageTemplate,
  downsellPageTemplate,
  optinPageTemplate,
  storefrontPageTemplate,
  quizPageTemplate,
  advertorialPageTemplate,
};
