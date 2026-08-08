# Integration lane (money path) — task queue

Branch: `integration/money-path`. Spec: docs/LANE-INTEGRATION.md.
Local env: Postgres 127.0.0.1:5433 db `puure_money`, server :4003.

[x] Slice 1: Sessions + pricing — co_sessions, checkoutPricing.js (Shopify
    GraphQL re-pricing, 503/422 split), POST /checkout/public/create-session
    (rate-limited, clamped, server-priced). Tests: valid cart, unknown
    variant 422, dead Shopify 503 pricing_unavailable, replayed create.
[x] Slice 2: Stripe test-mode — gateway adapter (PaymentIntents), signed
    webhook settle processing→paid, co_orders with unique idempotency_key.
    EXIT BAR: same webhook event twice → exactly one order, second no-op.
[x] Slice 3: Whop — client port (embedded checkout + saved payment method),
    settlement webhook, 1-click upsell charges (TRIPLE key), decline marker.
[x] Slice 4: Sweeps + refunds — 10-min reconciliation cron, stuck
    pending_settlement recovery, refunds writeback, co_unmatched_payments.
