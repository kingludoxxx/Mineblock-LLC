# Money-path adversarial review — findings, verdicts, fixes

Three independent reviewers (money/concurrency, security, platform) audited the
~2,500-line checkout lane. Every finding was **verified against the running
code/DB before any change** — money code must not be patched on speculation.
Result: **18 real issues fixed, 1 critical claim proven false, all locked by
new regression checks.** Full suite after fixes: **144/144** (29 sessions + 44
Stripe + 39 Whop + 16 sweeps + 16 review-locks), real server boots clean.

## Fixed — Critical / High

| # | Issue | Fix | Lock |
|---|---|---|---|
| F1 | Whop upsell webhook trusted body `charge_row` unscoped → a validly-signed event could settle/decline **another funnel's** charge row; amount guard bypassable by omitting amount fields | `settleUpsellCharge`/`failUpsellCharge` now require `expectedSessionId`; the row must belong to the authenticated session; the upsell branch refuses without a resolved session | slice5 F1 (settle + fail forgery refused) |
| C1 | Stripe off-session **transport failure misclassified as a decline** — a lost response after a real charge marked the row `declined`; a later re-accept could double-charge | adapter tags transport failures `transport:true`; the caller holds them `pending` (webhook/sweep decides), never declines | slice5 C1 |
| C2 | **Stripe webhook had no upsell branch** — a Stripe 1-click whose sync response was lost was settled by nothing | added the `kind='upsell'` branch (authoritative PI re-fetch → `settleUpsellCharge`) | slice5 C2 |
| C3 | Public re-accept **resurrected `needs_review` and `canceled` rows** — auto-retried an unprovable charge, and re-charged a disputed card | reclaim allow-list excludes `needs_review`/`canceled` | slice5 C3 ×2 |
| C4 | Whop order idempotency key **diverged between webhook and sweep** when the payload had no `data.id` → possible duplicate order | key derived from the same value stored in `gateway_session_id` | slice4 (unchanged) |
| M1 | `/upsell/accept` **ignored the settle result** after a successful charge → could report `settled` over a charge the books didn't reflect | on settle failure post-charge, park `needs_review` with the gateway id | slice5 M1 |
| M2 | **No reconciliation for stranded `processing` sessions** — a permanently-lost settlement webhook left captured money invisible | new sweep pass queries the gateway (read-only) and settles/parks | slice4 + sweep |
| #2 | `checkoutPublic` **had no body parser** under the stated mount order (before global `express.json`) → every public endpoint 422s in prod | router self-parses body + cookies (idempotent) | slice5 #2 (tested under real mount order) |
| #4 | `/stripe/create-intent` **minted a new Customer every call** + reused the PI idempotency key with different params → Stripe rejects retries, session unpayable 24h | reuse the session's stored customer; persist it before the PI call | regression (create-intent replay) |

## Fixed — Medium / hardening

| # | Issue | Fix |
|---|---|---|
| M5 | A dispute cancelled in-flight charges but didn't block **new** ones | `loadPaidSession` refuses disputed/refunded sessions (409) — slice5 M5 |
| #5 | Sweep env vars unclamped → `"0"`/garbage → 1 ms tight loop | `posInt` clamps with floors — slice5 #5 |
| #6 | Stripe cumulative `amount_refunded` booked as an incremental entry → over-count | fallback books only the delta vs recorded Stripe refunds |
| #7 | Whop refund/dispute (no metadata) couldn't verify under per-funnel secrets | resolve funnel by payment id **before** verification (mirrors Stripe) |
| #8 | Amount-mismatch returned 409 and unsettleable returned 500 → gateway **retry storms** for days | both ACK (200) after parking — slice5 #8 |
| #10 | Sweep had no in-flight guard → overlapping ticks | `sweepInFlight` sentinel |
| F4 | Webhook endpoints unauthenticated with **no rate limit** → DB-exhaustion amplification | per-IP ceiling (600/min, fail-open) before signature work |
| F5/#9 | Price cache **unbounded** (attacker-fed variant ids) | bounded `cacheSet` (5k cap, expired-then-oldest eviction) |
| F6/#11 | `PUT /upsells/:id` skipped price validation → `NaN`/negative reached NUMERIC | same validation as POST (422) — slice5 F6 ×2 |
| F7 | Funnel-pin bypassed for null-funnel offers/sessions | strict equality — a pinned offer is never reachable from a funnel-less session |
| F8 | Admin ILIKE search didn't escape `%`/`_` | metacharacters escaped — slice5 F8 |
| #14 | `whop.js` read body twice (`json()` then `text()`) → blanked decline detail; unbounded client `variant_id` in claim slot | read text once then parse; slice the client id |

## Rejected — verified false positive

- **"Every JSONB write sends `[object Object]` and 500s" (platform #1, restated as a money-path critical).** Proven false against the live DB: raw JS objects/arrays passed to `pgQuery` round-trip as proper JSONB (`jsonb_typeof` → `array`/`object`, nested reads work). The reviewer mis-modeled postgres.js. **Applying the proposed "fix" (`JSON.stringify`) would have double-encoded and broken every write** — the exact bug caught and removed in slice 4. This is why findings are verified before patched.

## Noted, not changed (out of lane / pre-existing)

- `pg.js` timeout race doesn't cancel the underlying query (shared infra, all lanes).
- Global error handler envelope shape differs from the checkout `{error:{code}}` on body-parser errors (shared `app.js`/`errorHandler.js`).
- Currency is not compared in amount checks — benign today (PIs/plans minted in the session's own currency); flagged for when multi-currency lands.
