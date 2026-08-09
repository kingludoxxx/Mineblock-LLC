// PAGE BUILDER — block registry.
//
// Maps 1:1 to the block types the server renderer supports on this commit
// (server/src/services/funnelRender.js renderBlockInner switch). Types the
// renderer only renders as "not in this slice" placeholders (form, quiz_embed)
// are deliberately OMITTED from the palette. The three unwired gateway
// checkouts (stripe_checkout / nmi_checkout / express_checkout) appear as
// VISIBLE-DISABLED "soon" entries (`soon: true`) — this platform is
// Whop-only, so they can never be inserted. checkout_template inserts but
// renders as an inert labelled placeholder on the public page (its def says
// so); order_bump / shipping_method / product have real visual renderer cases.
//
// Money blocks (whop_checkout / order_summary / upsell_offer) split their
// props into SAFE (copy/labels) and WIRING (variant/offer binding). Prices
// are NEVER a prop — the server re-prices; a `price` prop would be ignored.
import {
  Heading1,
  Type,
  MousePointerClick,
  Image as ImageIcon,
  Film,
  Minus,
  StretchHorizontal,
  Square,
  Columns3,
  Code2,
  Sparkles,
  List as ListIcon,
  ListChecks,
  Quote,
  HelpCircle,
  Trophy,
  Table2,
  LayoutGrid,
  Timer,
  Pin,
  FileCode2,
  CreditCard,
  ReceiptText,
  ArrowUpCircle,
  Gift,
  Truck,
  LayoutTemplate,
  Package,
  Banknote,
  Wallet,
  Zap,
} from 'lucide-react';

export const BLOCKS_MAX_COUNT = 500; // mirror of server BLOCKS_MAX_COUNT

export const CATEGORIES = [
  { id: 'basic', label: 'Basic' },
  { id: 'layout', label: 'Layout' },
  { id: 'blocks', label: 'Blocks' },
];

// Field kinds understood by the props panel:
//   text | textarea | number | select | url | color | variant
//   items         one-per-line string list
//   json          raw JSON sub-structure, validated before commit
//   rows          repeating OBJECT list — add / remove / reorder, with a
//                 nested editor per `itemFields`. Used by the list-shaped
//                 blocks (faq, ranking, product_grid).
//   compare_rows  the `rows` editor PLUS a column manager, for comparison_table
//                 (its columns are data — the first row's keys ARE the headers).
//   datetime      local date+time picker that stores a UTC ISO instant.
// `htmlSink: true` marks fields the server emits VERBATIM on the public page —
// the panel labels them accordingly and the canvas previews them sandboxed.
//
// THE FIELD SET IS THE RENDERER CONTRACT, NOT A WISHLIST. Every key below is
// one funnelRender.js actually reads for that block type; a field the renderer
// ignores would let an operator write copy that never appears on the page.
// Where the reference tool offers more than this renderer consumes, the extra
// field is omitted and the omission is commented at the block.
export const BLOCK_DEFS = {
  // ---- BASIC ----------------------------------------------------------------
  heading: {
    label: 'Heading',
    category: 'basic',
    icon: Heading1,
    inlineEditProp: 'text',
    defaults: () => ({ text: 'Your heading', level: 2 }),
    fields: [
      { key: 'text', label: 'Text', kind: 'text' },
      {
        key: 'level', label: 'Level', kind: 'select', coerce: 'int',
        options: [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `H${n}` })),
      },
    ],
  },
  text: {
    label: 'Text',
    category: 'basic',
    icon: Type,
    inlineEditProp: 'text',
    defaults: () => ({ text: 'Write something…' }),
    fields: [
      { key: 'text', label: 'Text', kind: 'textarea' },
      {
        key: 'html', label: 'HTML (advanced)', kind: 'textarea', mono: true, htmlSink: true,
        help: 'If set, overrides Text and renders VERBATIM on the public page.',
      },
    ],
  },
  button: {
    label: 'Button',
    category: 'basic',
    icon: MousePointerClick,
    inlineEditProp: 'text',
    defaults: () => ({ text: 'Click here', href: '#' }),
    fields: [
      { key: 'text', label: 'Label', kind: 'text' },
      {
        key: 'href', label: 'Link (href)', kind: 'url',
        help: "Use #fos-next / #fos-fallback to follow the funnel flow.",
      },
    ],
  },
  image: {
    label: 'Image',
    category: 'basic',
    icon: ImageIcon,
    defaults: () => ({ src: '', alt: '' }),
    fields: [
      // `media: 'image'` opts a url field into the inspector's picker/AI Media
      // affordance. It is NOT implied by kind:'url' — cta_href, video src and
      // every other link are url fields too, and offering an image picker on
      // them would be noise. `altKey` names the companion field a picked asset
      // should describe.
      { key: 'src', label: 'Image URL', kind: 'url', media: 'image', altKey: 'alt' },
      { key: 'alt', label: 'Alt text', kind: 'text' },
    ],
  },
  video: {
    label: 'Video',
    category: 'basic',
    icon: Film,
    defaults: () => ({ src: '' }),
    fields: [{ key: 'src', label: 'Video URL (mp4/webm)', kind: 'url' }],
  },
  divider: {
    label: 'Divider',
    category: 'basic',
    icon: Minus,
    defaults: () => ({}),
    fields: [],
  },
  spacer: {
    label: 'Spacer',
    category: 'basic',
    icon: StretchHorizontal,
    defaults: () => ({ height: 32 }),
    fields: [{ key: 'height', label: 'Height (px)', kind: 'number', min: 4, max: 400, coerce: 'int' }],
  },

  // ---- LAYOUT ---------------------------------------------------------------
  section: {
    label: 'Section',
    category: 'layout',
    icon: Square,
    defaults: () => ({ html: '', padding: '48px 24px', background: '', max_width: '1100px' }),
    fields: [
      { key: 'html', label: 'Inner HTML', kind: 'textarea', mono: true, htmlSink: true },
      { key: 'padding', label: 'Padding (CSS)', kind: 'text', placeholder: '48px 24px' },
      { key: 'background', label: 'Background (CSS color)', kind: 'text', placeholder: '#ffffff' },
      { key: 'max_width', label: 'Max width', kind: 'text', placeholder: '1100px' },
    ],
  },
  row: {
    label: 'Row (columns)',
    category: 'layout',
    icon: Columns3,
    defaults: () => ({ columns: [{ html: '' }, { html: '' }], gap: 16, align: 'stretch' }),
    fields: [
      {
        key: 'columns', label: 'Columns', kind: 'json', htmlSink: true,
        help: 'Array of { "html": "…" } — each column renders its HTML verbatim.',
      },
      { key: 'gap', label: 'Gap (px)', kind: 'number', min: 0, max: 120, coerce: 'int' },
      {
        key: 'align', label: 'Align', kind: 'select',
        options: ['stretch', 'flex-start', 'center', 'flex-end'].map((v) => ({ value: v, label: v })),
      },
    ],
  },
  custom_html: {
    label: 'Custom HTML',
    category: 'layout',
    icon: Code2,
    defaults: () => ({ html: '<div style="padding:24px;text-align:center">Custom HTML</div>', css: '' }),
    fields: [
      { key: 'html', label: 'HTML', kind: 'textarea', mono: true, htmlSink: true },
      { key: 'css', label: 'CSS', kind: 'textarea', mono: true, htmlSink: true },
    ],
  },

  // ---- BLOCKS (richer, all live on this commit) -----------------------------
  hero: {
    label: 'Hero',
    category: 'blocks',
    icon: Sparkles,
    defaults: () => ({ headline: 'Big promise headline', subheadline: 'Supporting line', cta_text: 'Learn more', cta_href: '#', image_url: '' }),
    fields: [
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'subheadline', label: 'Subheadline', kind: 'text' },
      { key: 'cta_text', label: 'CTA label', kind: 'text' },
      { key: 'cta_href', label: 'CTA link', kind: 'url' },
      { key: 'image_url', label: 'Background image URL', kind: 'url', media: 'image' },
    ],
  },
  list: {
    label: 'List',
    category: 'blocks',
    icon: ListIcon,
    defaults: () => ({ items: ['First item', 'Second item'] }),
    fields: [{ key: 'items', label: 'Items (one per line)', kind: 'items' }],
  },
  checklist: {
    label: 'Checklist',
    category: 'blocks',
    icon: ListChecks,
    defaults: () => ({ items: ['Benefit one', 'Benefit two'] }),
    fields: [{ key: 'items', label: 'Items (one per line)', kind: 'items' }],
  },
  // TESTIMONIAL is the Quote block. Its two fields are already the WHOLE
  // renderer contract: funnelRender.js emits <blockquote><p>{quote}</p>
  // <footer>— {author}</footer></blockquote> and reads nothing else. The
  // reference tool also offers an `avatar` image; this renderer emits no <img>
  // inside the quote, so no avatar field is offered here — it would write a
  // prop the published page silently drops.
  testimonial: {
    label: 'Testimonial (Quote)',
    category: 'blocks',
    icon: Quote,
    defaults: () => ({ quote: 'This changed everything for me.', author: 'Happy customer' }),
    fields: [
      { key: 'quote', label: 'Quote', kind: 'textarea' },
      {
        key: 'author', label: 'Author', kind: 'text',
        help: 'Printed after an em-dash. Left blank, the page prints “Anonymous”.',
      },
    ],
  },
  faq: {
    label: 'FAQ',
    category: 'blocks',
    icon: HelpCircle,
    defaults: () => ({
      title: 'FAQ',
      items: [
        { q: 'How long does shipping take?', a: 'Most orders arrive in 3-5 business days.' },
        { q: 'What is your return policy?', a: '30 days, no questions asked.' },
      ],
    }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      {
        key: 'items', label: 'Questions', kind: 'rows', rowLabel: 'Question',
        // Renderer contract (funnelRender.js `faq`): <summary>{q}</summary><p>{a}</p>.
        // q + a are the ONLY keys it reads — anything else would never print.
        itemFields: [
          { key: 'q', label: 'Question', kind: 'text' },
          { key: 'a', label: 'Answer', kind: 'textarea' },
        ],
        defaultItem: { q: 'New question?', a: 'Answer here.' },
        help: 'Each row renders as an expandable <details> on the public page.',
      },
    ],
  },
  ranking: {
    label: 'Ranking',
    category: 'blocks',
    icon: Trophy,
    defaults: () => ({ title: 'Top Picks', items: [{ rank: 1, name: 'Product', summary: 'Why it wins', score: 9.8 }] }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      {
        key: 'items', label: 'Ranked items', kind: 'rows', rowLabel: 'Item',
        // Renderer contract (funnelRender.js `ranking`): rank, name, summary,
        // score — and NOTHING else. The reference tool also offers image /
        // cta_text / cta_href per item; this renderer emits no <img> and no
        // <a> inside a ranking card, so those fields are deliberately ABSENT
        // rather than written as props the page would drop on the floor.
        itemFields: [
          { key: 'rank', label: 'Rank', kind: 'number', min: 1, max: 100, coerce: 'int' },
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'score', label: 'Score (out of 10)', kind: 'number', min: 0, max: 10, step: 0.1 },
          { key: 'summary', label: 'Summary', kind: 'textarea' },
        ],
        defaultItem: { rank: 1, name: 'New product', score: 9, summary: '' },
        help: 'Score prints as “x/10”. Rank also becomes the card’s anchor id on the page.',
      },
    ],
  },
  comparison_table: {
    label: 'Comparison table',
    category: 'blocks',
    icon: Table2,
    defaults: () => ({
      title: 'Comparison',
      rows: [
        { feature: 'Feature A', Us: 'Yes', Them: 'No' },
        { feature: 'Feature B', Us: 'Yes', Them: 'No' },
      ],
    }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      {
        key: 'rows', label: 'Rows', kind: 'compare_rows',
        help:
          'The FIRST row decides the columns — the published table reads its keys as the headers, ' +
          'so renaming a column here rewrites every row at once.',
      },
    ],
  },
  product_grid: {
    label: 'Product grid',
    category: 'blocks',
    icon: LayoutGrid,
    // No `title` field: funnelRender.js `product_grid` emits the cards only —
    // it never reads a title, so an editor for one would write a dead prop.
    // Put a Heading block above the grid instead.
    defaults: () => ({
      items: [
        { image: '', name: 'Product', summary: '', href: '#', cta: 'View' },
        { image: '', name: 'Product', summary: '', href: '#', cta: 'View' },
      ],
    }),
    fields: [
      {
        key: 'items', label: 'Products', kind: 'rows', rowLabel: 'Product',
        itemFields: [
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'summary', label: 'Summary', kind: 'textarea' },
          { key: 'image', label: 'Image URL', kind: 'url' },
          { key: 'cta', label: 'CTA label', kind: 'text' },
          { key: 'href', label: 'CTA link', kind: 'url', placeholder: '#fos-next' },
        ],
        defaultItem: { image: '', name: 'New product', summary: '', href: '#', cta: 'View' },
        help: 'Links are sanitized on the public page — only http(s), mailto, tel and relative URLs survive.',
      },
    ],
  },
  table: {
    label: 'Table',
    category: 'blocks',
    icon: Table2,
    defaults: () => ({ rows: [['Cell 1', 'Cell 2'], ['Cell 3', 'Cell 4']] }),
    fields: [{ key: 'rows', label: 'Rows', kind: 'json', help: 'Array of arrays of cell strings.' }],
  },
  countdown: {
    label: 'Countdown',
    category: 'blocks',
    icon: Timer,
    // Seeded a WEEK OUT rather than blank. An empty deadline is not a
    // countdown at rest — funnelRender's runtime finds no parseable instant
    // and leaves the clock on its static em-dash forever, so a freshly
    // inserted block looked broken. Any date is editable; none is not.
    defaults: () => ({
      label: 'Offer ends in',
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    fields: [
      { key: 'label', label: 'Label', kind: 'text' },
      {
        key: 'deadline', label: 'Deadline', kind: 'datetime',
        help:
          'Picked in YOUR timezone and stored as a UTC instant, so every visitor counts down to the same moment. ' +
          'When it passes, the clock reads “Offer expired”.',
      },
    ],
  },
  sticky_cta: {
    label: 'Sticky CTA',
    category: 'blocks',
    icon: Pin,
    defaults: () => ({ text: 'Buy Now', href: '#fos-next' }),
    fields: [
      { key: 'text', label: 'Label', kind: 'text' },
      {
        key: 'href', label: 'Link', kind: 'url',
        help: 'Use #fos-next / #fos-fallback to follow the funnel flow.',
      },
    ],
    help: 'Floats fixed at the bottom-centre of the live page, above everything else.',
  },
  html: {
    label: 'Raw HTML / Embed',
    category: 'blocks',
    icon: FileCode2,
    // Same posture as custom_html: seed something VISIBLE. An empty html prop
    // renders literally nothing on the public page, so a freshly inserted
    // block was indistinguishable from a failed insert.
    defaults: () => ({ html: '<div style="padding:24px;text-align:center">Paste your embed code here</div>' }),
    fields: [
      {
        key: 'html', label: 'HTML / embed code', kind: 'textarea', mono: true, htmlSink: true,
        help:
          'Rendered VERBATIM on the public page — <script> tags included, which is what makes third-party ' +
          'embed snippets work. Nothing is escaped or filtered, so paste only code you trust. ' +
          'The canvas previews it inside a sandboxed frame (no scripts, no page access), so what runs ' +
          'here is never what runs live.',
      },
    ],
    // NOTE: this block has NO css prop. funnelRender's `html`/`embed` case
    // returns p.html alone — only custom_html emits a companion <style>. Put
    // your CSS in a <style> tag inside the HTML above, or use Custom HTML.
  },

  // ---- MONEY BLOCKS ---------------------------------------------------------
  whop_checkout: {
    label: 'Whop Checkout',
    category: 'blocks',
    icon: CreditCard,
    money: true,
    defaults: () => ({ button_text: 'Complete order' }),
    fields: [{ key: 'button_text', label: 'Fallback button label', kind: 'text' }],
    wiringFields: [
      { key: 'variant_id', label: 'Shopify variant ID', kind: 'text', placeholder: '51234567890' },
      { key: 'quantity', label: 'Quantity', kind: 'number', min: 1, max: 99, coerce: 'int' },
      {
        key: 'line_items', label: 'Line items (multi-line cart)', kind: 'json',
        help: 'Optional. Array of { variant_id, quantity } — overrides the single variant above.',
      },
    ],
    wiringNote:
      'Wiring controls WHAT gets charged. Prices are always resolved server-side at checkout — a price prop here is ignored and can never influence the amount.',
  },
  order_summary: {
    label: 'Order Summary',
    category: 'blocks',
    icon: ReceiptText,
    money: true,
    defaults: () => ({ title: 'Order summary' }),
    fields: [{ key: 'title', label: 'Title', kind: 'text' }],
    wiringFields: [],
    wiringNote:
      'Filled at runtime from the server-priced checkout session. Nothing to wire — amounts can never be set here.',
  },
  upsell_offer: {
    label: 'Upsell Offer (1-click)',
    category: 'blocks',
    icon: ArrowUpCircle,
    money: true,
    defaults: () => ({
      headline: 'Wait — one exclusive offer before you go',
      subheadline: 'Add this to your order with one click. No need to re-enter your details.',
      accept_text: 'Add this to my order',
      decline_text: 'No thanks, I’ll pass on this one-time offer',
    }),
    fields: [
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'subheadline', label: 'Subheadline', kind: 'textarea' },
      { key: 'accept_text', label: 'Accept button', kind: 'text' },
      { key: 'decline_text', label: 'Decline link', kind: 'text' },
      { key: 'fine_print', label: 'Fine print', kind: 'textarea' },
    ],
    wiringFields: [
      { key: 'offer_id', label: 'Offer ID', kind: 'text', placeholder: 'leave empty for page default' },
    ],
    wiringNote:
      'The offer, image and PRICE are resolved server-side from the Offer ID (or the page default). No amount can be set from this editor.',
  },

  // ---- EDITOR-PARITY additions ----------------------------------------------
  // Visual commerce-adjacent blocks. Prices here are DISPLAY STRINGS only —
  // nothing in these blocks can feed a charge (the server treats them the
  // same way: static markup, esc()'d text, no money logic).
  // ORDER BUMP — the one block on this list that can move money.
  //
  // The server contract is LIVE: POST /api/v1/checkout/public/session/:id/bump
  // reads the PUBLISHED page's block props {variant_id, quantity} and re-prices
  // the variant against Shopify. Nothing here sets an amount — `price` stays a
  // DISPLAY STRING, and a bump with no variant_id is refused server-side
  // (422 bump_not_chargeable) rather than charged at the displayed number.
  order_bump: {
    label: 'Order Bump',
    category: 'blocks',
    icon: Gift,
    // No `label` here: it is the LEGACY key the renderer still falls back to
    // for older blocks. Seeding it on a NEW block would put a value behind
    // the headline field that the operator cannot see in the inspector.
    defaults: () => ({
      description: 'Special one-time deal, only available right now.',
      quantity: 1,
    }),
    // Field ORDER and COPY are operator-spec'd (reference-tool screenshots).
    // Block name is field 1 but lives in the SHARED inspector header, so it is
    // not repeated here.
    fields: [
      {
        key: 'variant_id', label: 'Shopify product', kind: 'variant',
        help: 'Variants and prices come live from Shopify; the published page creates the payment session server-side, so the buyer is always charged the current Shopify price.',
      },
      // KEY IS `headline`. Verified by execution against the renderer on main
      // (funnelRender.js order_bump): it resolves
      //   p.headline -> "Yes, I want the {offer_name}!" -> p.label -> default.
      // `label` is the LEGACY key and stays readable for blocks authored
      // before that change; new edits write `headline`, which wins.
      {
        key: 'headline', label: 'Checkbox headline', kind: 'text',
        placeholder: 'Yes, I want the … (auto from the offer name if blank)',
        help: 'Leave blank and the page builds it from the offer name. No price is inserted automatically — the amount charged is always the live Shopify price.',
      },
      {
        key: 'offer_name', label: 'Offer name (bold, before the description)', kind: 'text',
        placeholder: 'EMERGENCY WATER TEST KIT',
        help: 'Renders as a bold “NAME:” prefix on the description line, and fills the headline when that is left blank.',
      },
      {
        key: 'description', label: 'Description', kind: 'textarea',
        help: 'What it is and why to add it. <b>bold</b> and <u>underline</u> are allowed — everything else is shown as plain text.',
      },
      {
        key: 'quantity', label: 'Quantity per order', kind: 'number', min: 1, max: 10, coerce: 'int',
        help: 'Units added when the bump is accepted. The server clamps this to 1-10.',
      },
      {
        key: 'checked', label: 'Ticked by default', kind: 'select', coerce: 'bool',
        options: [{ value: '', label: 'No' }, { value: 'true', label: 'Yes' }],
      },
      {
        key: 'offer_name_color', label: 'Offer name color', kind: 'color',
        help: 'Tints the bold offer name. Must be a hex value (#111827) — anything else is ignored and the default ink is used.',
      },
      {
        key: 'price', label: 'Price (display text)', kind: 'text', placeholder: '$19.00',
        help: 'Filled in for you when you pick a product. Label only — the amount charged always comes from Shopify via the variant above, re-priced at checkout.',
      },
    ],
  },
  shipping_method: {
    label: 'Shipping Method',
    category: 'blocks',
    icon: Truck,
    defaults: () => ({
      title: 'Shipping method',
      options: [
        { label: 'Standard (5-7 days)', price: 'FREE' },
        { label: 'Express (2-3 days)', price: '$9.95' },
      ],
    }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      {
        key: 'options', label: 'Options', kind: 'json',
        help: 'Array of { "label": "…", "price": "…" }. Prices are display strings — shipping totals stay server-side.',
      },
    ],
  },
  product: {
    label: 'Product',
    category: 'blocks',
    icon: Package,
    defaults: () => ({
      name: 'Product name',
      description: 'Short product description.',
      price: '$49.00',
      cta_text: 'Buy now',
      href: '#fos-next',
      image: '',
    }),
    fields: [
      { key: 'image', label: 'Image URL', kind: 'url', media: 'image' },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'price', label: 'Price (display text)', kind: 'text', placeholder: '$49.00' },
      { key: 'cta_text', label: 'CTA label', kind: 'text' },
      { key: 'href', label: 'CTA link', kind: 'url', help: 'Use #fos-next to follow the funnel flow.' },
    ],
  },
  checkout_template: {
    label: 'Checkout Template',
    category: 'blocks',
    icon: LayoutTemplate,
    defaults: () => ({}),
    fields: [],
    help:
      'Renders as an inert labelled placeholder on the public page for now. For a live checkout use the Whop Checkout block (or create a page with the checkout type — it seeds the full template).',
  },

  // EXPRESS CHECKOUT — insertable LAYOUT PLACEHOLDER, no payment logic.
  //
  // It is in the server's PLACEHOLDER_TYPES set, so the public page renders a
  // labelled dashed box — the SAME mechanism checkout_template already ships
  // with. Inserting it reserves the slot in a layout; it can never take a
  // payment, and this block adds nothing that could.
  express_checkout: {
    label: 'Express Checkout',
    category: 'blocks',
    icon: Zap,
    defaults: () => ({}),
    fields: [],
    help:
      'Layout placeholder only. Apple Pay / Google Pay express buttons are NOT wired on this platform — the public page renders a labelled dashed box where this sits. Use the Whop Checkout block to actually take a payment.',
  },

  // Unwired gateway checkouts — visible but DISABLED in the palette
  // (`soon: true`). Whop is the only wired gateway on this platform.
  stripe_checkout: { label: 'Stripe Checkout', category: 'blocks', icon: Banknote, soon: true, defaults: () => ({}), fields: [] },
  nmi_checkout: { label: 'NMI Checkout', category: 'blocks', icon: Wallet, soon: true, defaults: () => ({}), fields: [] },
};

// Palette ordering per category.
export const PALETTE_ORDER = {
  basic: ['heading', 'text', 'button', 'image', 'video', 'divider', 'spacer'],
  layout: ['section', 'row', 'custom_html'],
  blocks: [
    'whop_checkout', 'order_summary', 'order_bump', 'shipping_method',
    'checkout_template', 'express_checkout', 'product', 'upsell_offer',
    'hero', 'list', 'checklist', 'testimonial', 'faq', 'ranking',
    'comparison_table', 'product_grid', 'table', 'countdown', 'sticky_cta', 'html',
    // Visible-disabled (soon) — unwired gateways on a Whop-only platform.
    'stripe_checkout', 'nmi_checkout',
  ],
};

// True when a palette type can actually be inserted (soon-entries cannot).
export function isInsertable(type) {
  const def = BLOCK_DEFS[type];
  return !!def && !def.soon;
}

export function blockDef(type) {
  return BLOCK_DEFS[type] || null;
}

export function blockLabel(block) {
  const def = BLOCK_DEFS[block?.type];
  const name = block?.props?.block_name;
  return name || def?.label || block?.type || 'Unknown';
}

let counter = 0;
export function newBlockId() {
  counter += 1;
  return `blk_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createBlock(type) {
  const def = BLOCK_DEFS[type];
  return {
    id: newBlockId(),
    type,
    props: def ? def.defaults() : {},
  };
}

// Blocks loaded from the server may lack ids (the renderer treats id as
// optional). Give every block a stable client id WITHOUT mutating the
// originals; ids that exist are preserved (they round-trip fine — server
// validation only requires type + props).
export function withIds(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((b) =>
    b && typeof b === 'object' && b.id ? b : { ...b, id: newBlockId() }
  );
}
