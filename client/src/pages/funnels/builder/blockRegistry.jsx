// PAGE BUILDER — block registry.
//
// Maps 1:1 to the block types the server renderer supports on this commit
// (server/src/services/funnelRender.js renderBlockInner switch). Types the
// renderer only renders as "not in this slice" placeholders (stripe_checkout,
// nmi_checkout, express_checkout, product, order_bump, checkout_template,
// shipping_method, form, quiz_embed) are deliberately OMITTED from the
// palette — the editor must never insert a block the public page can't render.
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
} from 'lucide-react';

export const BLOCKS_MAX_COUNT = 500; // mirror of server BLOCKS_MAX_COUNT

export const CATEGORIES = [
  { id: 'basic', label: 'Basic' },
  { id: 'layout', label: 'Layout' },
  { id: 'blocks', label: 'Blocks' },
];

// Field kinds understood by the props panel:
//   text | textarea | number | select | url | items (one-per-line string list)
//   json (raw JSON sub-structure, validated before commit)
// `htmlSink: true` marks fields the server emits VERBATIM on the public page —
// the panel labels them accordingly and the canvas previews them sandboxed.
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
      { key: 'src', label: 'Image URL', kind: 'url' },
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
      { key: 'image_url', label: 'Background image URL', kind: 'url' },
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
  testimonial: {
    label: 'Testimonial',
    category: 'blocks',
    icon: Quote,
    defaults: () => ({ quote: 'This changed everything for me.', author: 'Happy customer' }),
    fields: [
      { key: 'quote', label: 'Quote', kind: 'textarea' },
      { key: 'author', label: 'Author', kind: 'text' },
    ],
  },
  faq: {
    label: 'FAQ',
    category: 'blocks',
    icon: HelpCircle,
    defaults: () => ({ title: 'FAQ', items: [{ q: 'Question?', a: 'Answer.' }] }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'items', label: 'Items', kind: 'json', help: 'Array of { "q": "…", "a": "…" }' },
    ],
  },
  ranking: {
    label: 'Ranking',
    category: 'blocks',
    icon: Trophy,
    defaults: () => ({ title: 'Top Picks', items: [{ rank: 1, name: 'Product', summary: 'Why it wins', score: 9.8 }] }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'items', label: 'Items', kind: 'json', help: 'Array of { rank, name, summary, score }' },
    ],
  },
  comparison_table: {
    label: 'Comparison table',
    category: 'blocks',
    icon: Table2,
    defaults: () => ({ title: 'Comparison', rows: [{ feature: 'Feature A', Us: 'Yes', Them: 'No' }] }),
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'rows', label: 'Rows', kind: 'json', help: 'Array of objects; "feature" + one key per column.' },
    ],
  },
  product_grid: {
    label: 'Product grid',
    category: 'blocks',
    icon: LayoutGrid,
    defaults: () => ({ items: [{ image: '', name: 'Product', summary: '', href: '#', cta: 'View' }] }),
    fields: [
      { key: 'items', label: 'Items', kind: 'json', help: 'Array of { image, name, summary, href, cta }' },
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
    defaults: () => ({ label: 'Offer ends in', deadline: '' }),
    fields: [
      { key: 'label', label: 'Label', kind: 'text' },
      { key: 'deadline', label: 'Deadline (ISO date)', kind: 'text', placeholder: '2026-12-31T23:59:59Z' },
    ],
  },
  sticky_cta: {
    label: 'Sticky CTA',
    category: 'blocks',
    icon: Pin,
    defaults: () => ({ text: 'Buy Now', href: '#' }),
    fields: [
      { key: 'text', label: 'Label', kind: 'text' },
      { key: 'href', label: 'Link', kind: 'url' },
    ],
  },
  html: {
    label: 'Raw HTML / Embed',
    category: 'blocks',
    icon: FileCode2,
    defaults: () => ({ html: '' }),
    fields: [{ key: 'html', label: 'HTML', kind: 'textarea', mono: true, htmlSink: true }],
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
};

// Palette ordering per category.
export const PALETTE_ORDER = {
  basic: ['heading', 'text', 'button', 'image', 'video', 'divider', 'spacer'],
  layout: ['section', 'row', 'custom_html'],
  blocks: [
    'whop_checkout', 'order_summary', 'upsell_offer',
    'hero', 'list', 'checklist', 'testimonial', 'faq', 'ranking',
    'comparison_table', 'product_grid', 'table', 'countdown', 'sticky_cta', 'html',
  ],
};

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
