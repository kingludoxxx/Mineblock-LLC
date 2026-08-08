# Integration lane report — money path (slices 1–4 complete)

**Branch:** `integration/money-path` (4 commits on top of main; NOT merged — integrator merges)
**Status:** All 4 slices built and verified by execution. **128/128 automated checks pass**
(29 sessions/pricing + 44 Stripe + 39 Whop + 16 sweeps/refunds), full regression re-run
against the final code. Exit bar proven: **same webhook event delivered twice → exactly one
order; second delivery is a no-op** (also proven under 5-way concurrent delivery).

## What was built (all inside lane territory)

| File | Role |
|---|---|
| `server/src/services/checkoutSchema.js` | Single owner of all `co_*` DDL. Money-correctness in constraints: `co_orders.idempotency_key` UNIQUE, `co_upsell_charges (session, offer, charge)` TRIPLE, `co_webhook_events (gateway,id)` PK, `co_unmatched_payments.webhook_id` PK |
| `server/src/services/checkoutPricing.js` | Authoritative Shopify GraphQL re-pricing. Transport failure → 503 `pricing_unavailable`; unknown/draft/unpurchasable variant → omitted → 422. Never conflated, never falls back to client prices |
| `server/src/services/checkoutSettle.js` | THE settle path (atomic `processing→paid` claim + idempotent order insert; upsell settle/fail). Webhooks AND the sweep both call these — no re-implemented arithmetic |
| `server/src/services/gatewayConfigs.js` | Per-funnel gateway creds in `co_gateway_configs`, AES-256-GCM at rest, write-only (null keeps / "" clears / value replaces), reads return `*_set` booleans only. Env fallbacks: `STRIPE_*`, `WHOP_*` |
| `server/src/services/gateways/stripe.js` | PaymentIntents adapter: customer + intent (`setup_future_usage=off_session`), off-session upsell charge, local HMAC webhook verify (300s tolerance, multi-`v1` rotation), BNPL reuse gate (`card`/`link` only saved) |
| `server/src/services/gateways/whop.js` | Whop client: inline-plan dynamic-amount checkout config (`ch_…` embed id), Standard-Webhooks verify (both `ws_` raw and `whsec_` b64 key forms), off-session charge with **settled-status gate** (2xx ≠ money moved), `getPayment`, gross/net fee-band amount reconciliation |
| `server/src/services/moneySweeps.js` | 10-min in-process reconciliation cron (self-starts via gatewayWebhooks import; `MONEY_SWEEP_DISABLED=1` kills it without deploy). Settles lost-webhook pending charges via read-only gateway fetch, parks ambiguity at `needs_review` (never auto-retries), backfills paid-but-orderless sessions idempotently |
| `server/src/routes/checkoutPublic.js` | Public (unauthenticated by necessity, defended): `POST /create-session` (20/min/IP, clamps, $1 min, server prices only), `POST /stripe/create-intent`, `POST /whop/create-session`, `POST /upsell/accept` + `/upsell/decline` (TRIPLE-key claim slots, pending_settlement holds, same-processor rule), `GET /session/:id` (allow-listed fields) |
| `server/src/routes/gatewayWebhooks.js` | `POST /stripe` + `POST /whop` settle webhooks (raw-body signature verify fail-closed, authoritative re-fetch/reconcile, unmatched-payments queue) + refund/dispute writeback (idempotent per refund ref, cumulative→`refunded` computed in-SQL, disputes cancel outstanding charges) |
| `server/src/routes/checkoutAdmin.js` | CRM surface (`authenticate + requirePermission('checkout','access')`): sessions list/detail/stats (revenue = `paid` only), gateway creds GET/PUT, upsell offers CRUD, unmatched-payments queue, manual sweep trigger |
| `server/migrations/090_add_checkout_permission.sql` | `checkout: ["access"]` for Team - Full Access (090–099 reserved for this lane) |

## Integrator actions requested (shared files — not touched by this lane)

`server/src/app.js` — two mounts, positioned exactly like the existing webhook mounts
(BEFORE the global `express.json` and BEFORE `apiLimiter`; both routers parse their own
bodies — gatewayWebhooks captures rawBody for signatures):

```js
import gatewayWebhookRoutes from './routes/gatewayWebhooks.js';
import checkoutPublicRoutes from './routes/checkoutPublic.js';
// with the other webhook mounts (app.js ~line 65-69):
app.use('/api/v1/gateway-webhooks', gatewayWebhookRoutes);
app.use('/api/v1/checkout/public', checkoutPublicRoutes);
```

`server/src/routes/index.js` (or app.js after auth mounts):

```js
import checkoutAdminRoutes from './routes/checkoutAdmin.js';
app.use('/api/v1/checkout', checkoutAdminRoutes);
```

No render.yaml change needed — the sweep is in-process. Optional env (all read at request
time): `CHECKOUT_CREDS_KEY` (32-byte hex/b64; falls back to sha256(JWT_SECRET)),
`CHECKOUT_ALLOWED_ORIGINS`, `CHECKOUT_BASE_CURRENCY`, `CHECKOUT_BASE_URL`, plus platform
fallbacks `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PUBLISHABLE_KEY`,
`WHOP_API_KEY`/`WHOP_COMPANY_ID`/`WHOP_WEBHOOK_SECRET`.

## BLOCKED (operator input needed)

Stripe + Whop **test credentials** were not provided (per the lane doc). Everything is
verified against local mocks implementing the exact API surfaces, with real HMAC
signature verification throughout. When keys arrive: set them, unset
`STRIPE_API_BASE`/`WHOP_API_BASE`, and re-run the batteries (scratchpad
`test_slice2/3.mjs`) against live test modes. Do NOT register live webhooks from a dev
machine.

## Proof transcripts (actual outputs, local isolated DB `puure_money`)

Tampered client price ignored (sent `price: 0.01`, Shopify says $89):

```
POST /api/v1/checkout/public/create-session {"line_items":[{"variant_id":"58222941077807","quantity":2,"price":0.01}]}
→ 200 {"success":true,"data":{"session_id":"co_3374…","status":"processing",
       "line_items":[{"price":89,"line_total":178,…}],"totals":{"total":178},…}}
```

Exit bar (Stripe, signed events against the webhook):

```
POST /gateway-webhooks/stripe (signed payment_intent.succeeded)  → {"success":true,"settled":true}
POST same event again                                            → {"success":true,"already":true}
co_orders for the session: 1 row, idempotency_key = st_<pi_id>
5 CONCURRENT deliveries of one event → 5×200, exactly 1 settled, exactly 1 order
```

Whop settle + failure paths:

```
payment.succeeded (ws_-signed)      → settled; member+PM captured for 1-click
same webhook-id replayed            → {"duplicate":true}; new webhook-id same payment → {"already":true}
gross 50 vs total 89                → needs_review, session stays processing, no order
amount_after_fees 80.10 (net-only)  → settles (within 15% fee band); net 10 → needs_review
3 PARALLEL upsell accepts           → exactly 1 gateway charge call, 1 settled row
decline marker                      → $0 declined_by_user row, coexists with settled accept (TRIPLE key)
```

Sweeps + refunds:

```
pending_settlement w/ lost webhook  → sweep reads gateway → settled (same helpers as webhook)
stale 'charging' claim (45 min)     → needs_review 'stale_charging_claim' (never auto-retried)
paid session w/o order              → sweep backfills once; second sweep: 0 new orders
partial 44.50 + 44.50 refunds       → cumulative → status 'refunded'; replay → no double append
dispute                             → session parked + pending upsell charges canceled
```

Full regression on final code: `29 + 44 + 39 + 16 = 128 passed, 0 failed`. Real server
boots clean on the branch (health: database ok; migration 090 applied).

## Notes for the webhook-replay re-proof (integrator, pre-merge)

Start the server with a Stripe webhook secret set, then POST the same signed
`payment_intent.succeeded` twice (see `test_slice2.mjs` in this session's scratchpad for
the signing recipe: `t=<epoch>,v1=hex(hmac_sha256(secret, "<t>.<raw body>"))`). Expect
`settled:true` then `already:true` and a single `co_orders` row for the session.
