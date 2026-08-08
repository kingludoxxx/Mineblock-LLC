// Shared page-type config for the funnel canvas.
//
// The LEFT "ADD A PAGE" palette items come straight from the slice-3
// acceptance checklist (label + subtitle). Each palette item maps to one of
// the API's `type` enum values (see server/src/routes/funnels.js PAGE_TYPES:
// listicle | lead | quiz | checkout | upsell | downsell | thankyou | generic).
//
// Mapping decisions (documented — the palette has more entries than the enum):
//   Storefront (Product grid)     -> generic   (no storefront type yet)
//   Quiz (Multi-step questions)   -> quiz
//   Lead / Advertorial (Listicle) -> lead
//   Checkout (Payment page)       -> checkout
//   Upsell (1-click offer)        -> upsell
//   Downsell (Fallback offer)     -> downsell
//   Thank You (Confirmation)      -> thankyou
//   Customer Portal (Self-service)-> generic   (no portal type yet)
//   Generic / Opt-in (Blank+form) -> generic

import {
  Store,
  ListChecks,
  FileText,
  CreditCard,
  ArrowUpCircle,
  ArrowDownCircle,
  PartyPopper,
  UserCog,
  LayoutTemplate,
} from 'lucide-react';

export const PALETTE = [
  { key: 'storefront', label: 'Storefront', subtitle: 'Product grid', type: 'generic', icon: Store },
  { key: 'quiz', label: 'Quiz', subtitle: 'Multi-step questions', type: 'quiz', icon: ListChecks },
  { key: 'lead', label: 'Lead / Advertorial', subtitle: 'Listicle, VSL', type: 'lead', icon: FileText },
  { key: 'checkout', label: 'Checkout', subtitle: 'Payment page', type: 'checkout', icon: CreditCard },
  { key: 'upsell', label: 'Upsell', subtitle: '1-click offer', type: 'upsell', icon: ArrowUpCircle },
  { key: 'downsell', label: 'Downsell', subtitle: 'Fallback offer', type: 'downsell', icon: ArrowDownCircle },
  { key: 'thankyou', label: 'Thank You', subtitle: 'Confirmation', type: 'thankyou', icon: PartyPopper },
  { key: 'portal', label: 'Customer Portal', subtitle: 'Self-service', type: 'generic', icon: UserCog },
  { key: 'generic', label: 'Generic / Opt-in', subtitle: 'Blank + form', type: 'generic', icon: LayoutTemplate },
];

// Type -> color + label used by the node card header and stat chips. Colors
// are inline (React Flow nodes render outside Tailwind's utility scanning in
// some builds) but derived from the Puure dark palette so the look stays
// on-brand. `accent` is the gold from index.css.
export const TYPE_META = {
  listicle: { label: 'Listicle', color: '#c9a84c', icon: FileText },
  lead: { label: 'Lead / Advertorial', color: '#c9a84c', icon: FileText },
  quiz: { label: 'Quiz', color: '#8b5cf6', icon: ListChecks },
  checkout: { label: 'Checkout', color: '#22c55e', icon: CreditCard },
  upsell: { label: 'Upsell', color: '#3b82f6', icon: ArrowUpCircle },
  downsell: { label: 'Downsell', color: '#f59e0b', icon: ArrowDownCircle },
  thankyou: { label: 'Thank You', color: '#ec4899', icon: PartyPopper },
  generic: { label: 'Generic', color: '#a1a1aa', icon: LayoutTemplate },
};

export function typeMeta(type) {
  return TYPE_META[type] || TYPE_META.generic;
}

// Cosmetic S/M/L device toggle -> node card width (px). Aspect only, this slice.
export const DEVICE_WIDTHS = { S: 180, M: 240, L: 320 };
