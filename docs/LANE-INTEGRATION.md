# Lane: INTEGRATION (money path) — session handoff doc
_Read this fully before your first change. You are one lane of a multi-session
build; an integrator session owns merges and shared files. Your mission: port
the MONEY PATH of the reference system ("Funnel OS", a complete FastAPI+Mongo
codebase at `/Users/ludo/funnel-os`) natively into THIS repo (Express+Postgres,
the live "Puure dashboard"). Money code gets maximum care: bugs here are
silent and cost real dollars._

## Context in 60 seconds
- This repo deploys to puure-dashboard.onrender.com (live). CRM phase 1
  (Orders/Customers, Shopify sync + webhooks) is DONE and live.
- A parallel lane is building the Funnel Builder (funnels/pages/canvas).
  Checkout pages will MOUNT onto your money backend later — you do NOT need
  pages to exist. Everything you build is verified via curl.
- The reference system's docs are AUTHORITATIVE on behavior:
  `/Users/ludo/funnel-os/docs/DATA-MODEL.md` (§Commerce: co_sessions,
  co_upsells, co_upsell_charges, co_orders, co_webhook_events,
  co_unmatched_payments), `DATA-FLOW.md` (hops 6-10), `ARCHITECTURE.md` (§5),
  and **DECISIONS.md — read it BEFORE writing any code; violating its rules
  is the definition of failure in this lane.**
- Reference source to port from (Python → read for logic, reimplement in JS):
  `backend/app/services/checkout_pricing_service.py`,
  `checkout_finalize_service.py`, `lb_money_sweeps.py`, `whop_client.py`,
  `lb_stripe_service.py`, `lb_upsell_lines_service.py`,
  `backend/app/routers/checkout_public*.py`, `checkout_webhooks_whop.py`.

## Non-negotiables (from DECISIONS.md — carry over verbatim)
1. `processing` = payment INTENT, only `paid` = money moved. Every revenue
   query filters `paid`.
2. Money writes are idempotent BY CONSTRUCTION: unique index on a
   deterministic key (`co_orders.idempotency_key`, per-cycle rebill keys) or
   atomic status claim (`pending → importing`). NEVER read-then-write.
3. On ambiguity, park at `import_failed`/`needs_review` — never auto-retry a
   write that can't prove the previous attempt failed.
4. Prices are re-derived server-side from the Shopify variant record, always.
   Client prices are NEVER trusted; quantities clamped.
5. Pricing failure semantics: commerce-backend TRANSPORT failure → retryable
   **503 pricing_unavailable**; unknown/unpurchasable variant → OMIT the line
   so caller rejects as **422**. Never conflate.
6. Upsell charges: uniqueness on the TRIPLE (session, offer, charge) — accept
   AND decline both write rows; a $0 decline marker must never be settled.
7. The webhook is the PRIMARY settler; the sweep cron reconciles what webhooks
   missed and MUST reuse the webhook's own money helpers (same functions, not
   re-implemented arithmetic).
8. Money = fail-closed. (Serving/analytics = fail-open — not your lane.)
9. Gateway credentials are per-funnel operator data (stored encrypted,
   write-only API: null keeps, "" clears, value replaces; reads return only
   `*_set` booleans). Platform-wide fallbacks may use env.

## House conventions (copy the pattern from `server/src/routes/orders.js`)
- One self-contained route file per feature; `router.use(authenticate,
  requirePermission('<key>','access'))`; admin endpoints under /api/v1.
- PUBLIC checkout endpoints are unauthenticated by necessity — put them in a
  separate route file (auth boundary = file boundary) and mount them raw in
  `server/src/app.js` style (see how shopify-webhook mounts with rawBody);
  defend them: per-IP rate limit, origin checks, server-side re-pricing.
- DDL lives in the route file's `ensureTables()` **serialized behind a single
  in-flight promise** (copy orders.js exactly — parallel CREATE TABLE races
  crash Postgres).
- `pgQuery` (from `../db/pg.js`) returns a rows ARRAY (no `.rows`), 8s
  timeout. For JSONB params pass raw JS objects/arrays — NEVER
  JSON.stringify (double-encodes).
- Response envelope `{success, data}`; parameterized SQL only.
- Client pages (later, minimal): p-6 wrapper, theme tokens, lucide icons,
  `api` service. UI polish is explicitly deferred project-wide.

## Your file territory (do not touch anything else)
- NEW: `server/src/routes/checkoutPublic.js` (public), `server/src/routes/
  checkoutAdmin.js` (admin), `server/src/services/checkoutPricing.js`,
  `server/src/services/gateways/whop.js`, `.../gateways/stripe.js`,
  `server/src/routes/gatewayWebhooks.js`, `server/src/services/moneySweeps.js`.
- Tables you own (co_ prefix): co_sessions, co_upsells, co_upsell_charges,
  co_orders, co_events, co_webhook_events, co_unmatched_payments.
- Migrations: numbers **090–099 are reserved for this lane** (086-088 taken).
  Permission migration: `{"checkout": ["access"]}` for 'Team - Full Access'.
- SHARED (integrator-only — request via your report, do not edit):
  `server/src/routes/index.js`, `server/src/app.js`, `client/src/App.jsx`,
  `client/src/components/layout/Sidebar.jsx`.

## Slices (verify each by execution before the next; work on branch `integration/money-path`)
1. **Sessions + pricing.** co_sessions table; `checkoutPricing.js` re-pricing
   against Shopify variants (creds: see below; the Products/Variants API is
   the price authority); `POST /checkout/public/create-session` (rate-limited,
   re-priced, clamped, tracking snapshot fields nullable for now).
   Tests: valid cart → session `processing` with server prices (ignore client
   prices in body); unknown variant → 422 path; Shopify unreachable (point at
   a dead host in a test) → 503 pricing_unavailable; replayed create → new
   session (sessions are not idempotent, charges are).
2. **Stripe test-mode.** Gateway adapter (PaymentIntents), webhook settle
   (signature-verified) flipping `processing → paid`, `co_orders` write with
   unique idempotency_key. **Webhook replay proof: same event twice → exactly
   one order, second is a no-op.** This proof is the lane's exit bar.
3. **Whop.** Client port (embedded checkout + saved payment method),
   settlement webhook, 1-click upsell charge on the saved method:
   `co_upsell_charges` with the TRIPLE key; decline marker path.
4. **Sweeps + refunds.** 10-min reconciliation cron (in-process, one instance;
   register like other crons in this repo), stuck-`pending_settlement`
   recovery, refunds writeback, co_unmatched_payments queue.

## Environment recipe (local, isolated — NEVER the prod DB)
- Local Postgres runs at 127.0.0.1:5433 (user `puure`, trust auth, no psql
  binary — use node with the repo's `postgres` package for admin queries).
  Create your own DB `puure_money`. Run the server with:
  `DATABASE_URL='postgres://puure@127.0.0.1:5433/puure_money' NODE_ENV=development
  PORT=4003 SUPERADMIN_EMAIL='money@local.test' SUPERADMIN_PASSWORD='MoneyDev2026!'
  node server/src/server.js`
- Fresh-DB quirk: boot migrations abort at 025 (references a lazily-created
  table; known repo issue) which also skips seeds. Fix once: apply each
  migration file in sorted order via node/postgres inside a transaction,
  recording filenames in `_migrations`; on "does not exist" errors record-and-
  continue (mirrors prod state). Then restart → seeds create your superadmin.
- Shopify (Puure store) creds for pricing: `source ~/.config/puure/shopify.env`
  → PUURE_SHOPIFY_STORE / PUURE_SHOPIFY_TOKEN (also readable as
  SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN fallbacks in existing code).
- Stripe/Whop TEST credentials: NOT yet provided. Build against their test
  modes; when you need keys, mark the task BLOCKED per protocol and note it
  in your report — the operator (Ludo) supplies them. Stub-verify signature
  logic with self-generated test signatures meanwhile.
- Do NOT register any webhooks against live external services from this lane;
  webhook handlers are verified locally by POSTing signed payloads.

## Protocol (repo CLAUDE.md applies in full)
Verify by execution; test failure paths (bad signature, replay, dead Shopify,
malformed payload) — a money-path fix is unverified until run down its failure
path. Log to logs/progress.md per the repo format. Commit on your branch;
NEVER merge to main yourself — report to the operator/integrator with actual
outputs (curl transcripts) and the branch name. The integrator runs the
webhook-replay proof again before merge.
