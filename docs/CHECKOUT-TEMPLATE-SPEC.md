# Checkout page template — replicate Ludo's live Puure checkout (Stripe-powered)
_Design spec from Ludo's actual checkout screenshot (2026-08-08). The live page
is Whop-hosted; we rebuild the SAME layout as our own editable funnel-builder
checkout page, with the Stripe Payment Element in the payment slot. Do NOT
scrape the live URL (live session token + Whop SPA)._

## Layout: two columns (left form ~60%, right order-summary ~40%; stacks on mobile)

### LEFT column (the form)
1. **Brand** — Puure. wordmark, centered.
2. **Urgency banner** — pink rounded pill: "Our most-loved breast lift device is
   currently in high demand. Order today while inventory lasts" (operator text).
3. **Contact** — Email (required), Phone (optional, with country flag +1).
4. **Delivery** — Country (select), First name / Last name (two-up), Address,
   Apt/suite (optional), City, State/province (select) / Postal code (two-up).
5. **Shipping method** — selectable card: "Free tracked Shipping · 6-8 business
   days · FREE" (radio, blue-highlighted when selected). Support N methods.
6. **Billing address** — checkbox "Billing address same as shipping address"
   (checked by default); unchecking reveals a billing address block.
7. **Payment method** — a card container:
   - **Card** (radio, selected) → **Stripe Payment Element** mounts here
     (card number / MM·YY / CVC). This REPLACES Whop's card field.
   - Pay with Crypto (radio) — visual option; wire later (placeholder now).
   - Bank transfer (radio) — visual option; placeholder now.
   - Fine print: "By purchasing, you agree to Puure's terms and conditions."
   - (Remove "Powered by Whop" — this is our own checkout.)
8. **Complete checkout** — full-width black button → confirms the Stripe payment.
9. **Trust badges row** — Apple Pay, GPay, PayPal, Visa, MC, Amex, Discover.
10. **Footer links** — Return policy · Privacy policy · Terms of service.

### RIGHT column (order summary)
- "Continue shopping" link top-right (cart icon).
- **Order summary** heading.
- Line item: product thumbnail + name (e.g. "Puure™ Breast Lift Device") + price.
- **Promo code** input + Apply button.
- Subtotal, Savings (negative, e.g. -$100.00), **Total** (USD, bold).
- All numbers driven by the created co_session (NOT client-entered prices).

## Data wiring (to the existing money path — do not rebuild it)
- On load: POST /api/v1/checkout/public/create-session { funnel_id, page_id,
  line_items:[{variant_id, quantity}], gateway:'stripe' } → session_id + server
  totals → populate the order summary.
- Contact + delivery fields → session customer/shipping (session-contact update
  endpoint if present, else include on create/confirm per checkoutPublic.js).
- Payment: stripe/create-intent(session_id) → client_secret → Stripe Payment
  Element → Complete checkout confirms.
- Promo/savings: display from session if supported; promo-apply is later.
- NEVER send trusted prices; server re-prices (DECISIONS #4).

## Style
Clean, light, lots of white space, rounded inputs with subtle borders, black
primary button, blue accent on selected shipping. This template is LIGHT even
though the Puure admin is dark — it's the buyer-facing page, its own theme.
Make it the default 'checkout' page template operators get, fully editable.
