/**
 * Canonical visual-format registry for statics.
 *
 * Two things live here that used to live nowhere:
 *
 * 1. THE FORMATS THEMSELVES. Until now the format list existed only in an
 *    operator-side batch script, so the tool had no idea what layouts it could
 *    produce and the UI could not offer them. A format is now a first-class
 *    object the server owns.
 *
 * 2. A PER-FORMAT WORD CAP. A single 20-word budget across every layout was
 *    wrong in both directions: type-led cards land at 8-18 words unprompted,
 *    while EVERY word-count flag in the 20-card audit was a checklist or a
 *    diagram — layouts whose whole job is to carry labelled elements. Forcing
 *    those to 20 would gut them; leaving the cap at 20 flags them forever.
 *
 * `cap` counts EVERY visible word: headline, sub-line, cell, label, badge,
 * price, wordmark, attribution. It is the same number the vision auditor scores
 * against, so generation and QC cannot disagree about what "too much" means.
 *
 * `allowsGrid` gates tables/checklists/matrices. The image model will reach for
 * a comparison table whenever an angle's proof point mentions one, regardless of
 * the layout asked for — this flag is what lets the renderer and the auditor
 * both say no.
 */

export const STATICS_FORMATS = Object.freeze([
  {
    id: 'statement',
    label: 'Big-type statement',
    cap: 12,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Big-type statement card: the headline IS the visual, set in heavy editorial type on a clean brand-coloured field, product small and secondary at the bottom.',
  },
  {
    id: 'hero',
    label: 'Product hero',
    cap: 15,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Product hero: the device large and centred on a clean studio surface, one short headline above and a single supporting line below.',
  },
  {
    id: 'diagram',
    label: 'Annotated cross-section',
    cap: 30,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Annotated cross-section diagram: a clean illustrative diagram showing depth beneath the skin surface with a labelled depth callout and arrows. Diagrammatic, not photographic anatomy.',
  },
  {
    id: 'checklist',
    label: 'Checklist',
    cap: 32,
    allowsGrid: true,
    maxRows: 4,
    prompt: 'Checklist card: a short list of what does and does not work, ticks and crosses down the left, product bottom-right. Each row is a DIFFERENT subject — never repeat a row label.',
  },
  {
    id: 'quote',
    label: 'Quote card',
    cap: 20,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Quote card: a single sentence from the messenger set in large quotation marks, a named attribution line beneath, product understated.',
  },
  {
    id: 'split_screen',
    label: 'Split screen',
    cap: 16,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Split-screen: left half the failed conventional approach rendered as an object (a jar of cream, a price tag), right half the product. One short label per side.',
  },
  {
    id: 'numbered',
    label: 'Numbered explainer',
    cap: 26,
    allowsGrid: true,
    maxRows: 3,
    prompt: 'Numbered explainer: three numbered facts stacked vertically, each one short line, product at the base.',
  },
  {
    id: 'editorial',
    label: 'Magazine editorial',
    cap: 24,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Magazine editorial layout: a serif headline, one short standfirst line, generous white space, product photographed like a product-review page.',
  },
  {
    id: 'data_card',
    label: 'Data card',
    cap: 18,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Data card: one dominant number or figure filling the upper half, a one-line explanation beneath it, product small. NO table — the number is the whole point.',
  },
  {
    id: 'pattern_interrupt',
    label: 'Pattern interrupt',
    cap: 10,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Pattern-interrupt: a bold short line of type on a saturated flat colour background, product silhouetted, nothing else competing.',
  },
  {
    id: 'comparison_table',
    label: 'Comparison table',
    cap: 35,
    allowsGrid: true,
    maxRows: 3,
    prompt: 'Comparison table: a SPARSE table, at most 3 rows and 3 columns, single-word cells and tick/cross marks only — no sentences. Product image in the winning column. Every row and every column header must be a DIFFERENT subject.',
  },
  {
    id: 'lifestyle',
    label: 'In-context lifestyle',
    cap: 14,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'In-context lifestyle: the device resting on a real domestic surface (bathroom counter, bedside table) in soft natural light, one short overlay line of type.',
  },
  {
    id: 'icon_row',
    label: 'Icon row',
    cap: 22,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Icon row: three or four simple icons across the middle with one-word labels beneath, headline above, product below.',
  },
  {
    id: 'badge_trust',
    label: 'Badge / trust',
    cap: 20,
    allowsGrid: false,
    maxRows: 0,
    prompt: 'Badge/trust card: the product centred with a small row of credibility badges beneath it and a single headline above.',
  },
]);

export const DEFAULT_FORMAT_CAP = 20;

const BY_ID = new Map(STATICS_FORMATS.map(f => [f.id, f]));

/** Look up a format by id. Returns null for unknown ids — callers decide. */
export function getFormat(id) {
  if (!id) return null;
  return BY_ID.get(String(id).trim().toLowerCase()) || null;
}

/**
 * Word cap for a format id, falling back to the flat default.
 *
 * An UNKNOWN id must not silently inherit the strictest cap — that would flag
 * every card generated through a custom brief. The default is the old flat 20.
 */
export function capFor(id) {
  const f = getFormat(id);
  return f ? f.cap : DEFAULT_FORMAT_CAP;
}

/**
 * Resolve a format from either an id or a free-text prompt string, so callers
 * that already pass prose (the operator batch scripts) keep working and still
 * get the right cap. Matches on id first, then on an exact prompt match, then
 * on the label appearing in the text.
 */
export function resolveFormat(idOrText) {
  if (!idOrText) return null;
  const s = String(idOrText).trim();
  const byId = getFormat(s);
  if (byId) return byId;
  const lower = s.toLowerCase();
  return STATICS_FORMATS.find(f => f.prompt.toLowerCase() === lower)
      || STATICS_FORMATS.find(f => lower.startsWith(f.label.toLowerCase()))
      || STATICS_FORMATS.find(f => lower.includes(f.label.toLowerCase()))
      || null;
}
