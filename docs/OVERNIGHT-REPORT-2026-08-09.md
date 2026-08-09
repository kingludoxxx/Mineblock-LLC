# Overnight build report — Puure CRM
**Session:** 2026-08-08 night → 2026-08-09 morning · **Branch:** `main` @ `a32cc39` (pushed, **not deployed**)

---

## SCORE

| Dimension | Score | Basis |
|---|---|---|
| **Money-path correctness** | **8.5 / 10** | Every invariant from the friend's file upheld and verified by execution; 3 integration-seam bugs + 1 exploit found and fixed before shipping |
| **Security** | **7.5 / 10** | A real forced-charge exploit closed; session-id leak stopped. Residual: rate limits spoofable via `X-Forwarded-For`; `/track/collect` still accepts client `custom_data` |
| **Spec fidelity to the friend's design** | **7 / 10** | Hard invariants ported faithfully, 3 places improved on his implementation; combine-mode and the cost/P&L layer not built |
| **Operator surface (UI)** | **7 / 10** | Builder, settings, domains, analytics AND split-test UI all shipped + reviewed; no read surface for opt-in leads |
| **Production readiness** | **6 / 10** | Never deployed, never charged a real card. Fresh-DB bootstrap repaired but not fully clean |
| **OVERALL** | **7 / 10** | Strong core, honestly measured, not yet proven with real money |

**One-line verdict:** the expensive part (money correctness) is genuinely good; the remaining risk is concentrated in things only a live transaction can prove.

---

## WHAT WAS BUILT AND MERGED (11 subsystems, each adversarially reviewed before merge)

| Subsystem | Commit | Verification |
|---|---|---|
| Shopify order creation on settlement | `fc12b96` | 56/56 |
| One-click upsell page | `2407f40` | 49/49 |
| Split-test engine (ledger, resolver, credits) | `4aa24d3` | 48/48 |
| Tracking & attribution | `1324290` | 43/43 |
| Integration wiring (split ↔ money ↔ tracking) | `c68c6c7` | boot-smoke green |
| Page builder (drag-drop editor) | `e68926b` | real-browser E2E |
| Funnel settings + dual live/sandbox gateway creds | `1c78be9` | 33/33 |
| 6 funnel page types + countdown | `67cec8a` | 81/81 |
| Domain hub (buy / attach / auto-DNS) | `21bcb8e` | 127/127 |
| Money seam fixes | `2bd1e77` | 15/15 |
| Security + boot repair | `b001454` | 9/9 |
| Funnel analytics + split results | `dca50fe` | 209/209 |
| funnelPublic binary-file fix | `2a992d1` | live headers verified |

**Total: 485 assertions green across 8 standing harnesses** (56+49+15+9+15+81+48+212).

---

## THE SIX THINGS THAT WOULD HAVE COST REAL MONEY

Found by adversarial review / integrated bug hunts, all fixed and proven:

1. **Forced-charge exploit (HIGH).** The checkout `session_id` was an unauthenticated *charge authorization*. A reviewer executed **$897 of real charges** on a victim's saved card holding only a leaked id — and we were broadcasting that id to Meta's CAPI, the access log, and `lb_touches`. Fixed with an HttpOnly confirmation token; attack now returns 403 with zero gateway calls (9/9).
2. **Every Stripe order credited $0 revenue to its A/B arm.** A missing `total` in one SELECT became `NaN`, which a helper silently coerced to a valid $0.00 credit. Conversion counts looked healthy, so **any A/B winner picked on revenue was decided by noise.**
3. **Upsell refunds hit the base order.** Flipped the base order to "refunded" and erased base arm revenue while the upsell leg stayed settled.
4. **Whop refunds/chargebacks never reversed arm revenue** — on your live gateway, arm revenue could only go up.
5. **A $5 partial upsell refund erased a whole $200 revenue leg** in analytics (could flip an A/B winner).
6. **Gateway credentials could not be saved in production at all** — the encryption key read an env var nothing provisions. **This alone would have blocked the morning test.**

Plus: a fresh database could never finish migrating (dead on arrival for any new instance, while reporting healthy) — 26 → 64 migrations, roles and login restored.

---

## COMPLETION vs THE FRIEND'S FULL FILE

- **Core loop (funnel → checkout → order → upsell → tracking → split):** ~**85%**
- **Full Funnel OS feature set:** ~**65%**

**Upheld from his file (verified, with citations both sides):** exactly-once by unique key + atomic claim at every money write · the `(session, group, charge)` composite key including charge id · decline markers structurally isolated · deterministic `pur_<session>` + unique `(pixel_id, event_id)` · set-on-insert bot flags (never mass-mark) · no TTL on the first-seen registry · `processing` ≠ `paid` · 503-transport vs 422-unknown-variant · per-event rejections excluded from the delivery breaker · fail-open serving / fail-closed money · `no-store` on every non-200.

**We went further than his implementation in 3 places:** append-only void rows instead of his in-place `refunded_value` mutation (more faithful to his own ledger philosophy); three unique indexes on split credits instead of one; client event-id namespacing so a beacon can never suppress the server-minted Purchase.

**Not built (ranked by impact):**
1. **Combine mode.** Each accepted upsell becomes its **own Shopify order** — a buyer taking base + 2 upsells creates 3 orders, 3 confirmation emails, 3 fulfilment picks. His combine mode exists to avoid exactly this.
2. **Cost / COGS / P&L layer** — you see gross, not profit.
3. **Operator "import overdue" indicator** — a stranded order is currently invisible unless someone reads logs.
4. **NMI + PayPal gateways** (deliberate: you run Whop).
5. Custom S2S networks, autocapture, exit tracking.

---

## WHAT'S NEEDED TO MOVE FORWARD

### Morning: the live checkout test (~15 min, together)
1. Set on the Puure service: `CHECKOUT_CREDS_KEY` (32-byte hex — stable, so creds survive JWT rotation), `SHOPIFY_ORDER_CREATE_ENABLED=1`, `PUURE_SHOPIFY_STORE`, `PUURE_SHOPIFY_TOKEN`.
2. Deploy `main` (checkout stays dark — `FUNNEL_PUBLIC_ENABLED` is off).
3. You enter Whop **live** keys in the dashboard (encrypted, write-only): api_key + company_id (`biz_…`) + webhook_secret.
4. Register the Whop webhook → `https://puure-dashboard.onrender.com/api/v1/gateway-webhooks/whop`.
5. Publish one checkout funnel on the cheapest real variant; flip `FUNNEL_PUBLIC_ENABLED=1`.
6. Place **one real order** → verify `processing → paid → Shopify order in store → appears in Orders`.
7. **Replay the webhook** → prove zero duplicates. Then **refund**, flip the flag off.
8. Rotate the exposed keys (Whop / Shopify / GitHub).

### Before real traffic
- **Get the licence in writing from your friend.** `NOTICE.md` grants *no rights*; his own TASKS.md lists it as blocking for go-live. Zero engineering cost, unbounded legal downside.
- Wire real policy links (Return/Privacy/Terms are `href="#"`).
- Decide combine mode deliberately (or accept multi-order fulfilment).
- Set `TRACKING_DEFAULT_CONSENT=denied` if you take EEA/UK traffic.
- Pin `trust proxy` to Render's CIDR (rate limits are currently spoofable via `X-Forwarded-For`).

### Known-open (honest)
- Split-test UI is now MERGED (43/43 + 37/37, reviewed, 4 blockers fixed). Moving the control arm and archiving arms are API-only — no UI affordance yet.
- `/track/collect` still accepts client-chosen `custom_data` on non-Purchase events (ad-signal poisoning vector).
- Fresh-DB migration chain still has pre-existing legacy failures in creative/statics/spy areas (unrelated to CRM).
- 22 RBAC permissions referenced in code that no role grants (all pre-existing; one live break: the statics template picker 403s for non-superadmins).

---

## LATE AUDIT FINDINGS (arrived after the first draft — all acted on)

Three deep sub-audits landed late and changed the picture. Fixed and pushed:

- **The split test doesn't split (CRITICAL).** Arms are assigned and measured, but the serve path renders by slug and the upsell loads the offer the *client* names — so `lb_split_arms.page_id/offer_id` are written and read by nothing. Every arm serves the identical page. A correct significance engine pointed at two samples from the same distribution **will** eventually print "winner, 97% confidence" — demonstrated live (`status=winner, leader=b`). Now gated: the API refuses to name a winner (`blocked_reason: arm_delivery_not_wired`) until serve-time delivery is built. **You cannot A/B a landing page yet** — only what happens after a session exists.
- **SSRF in the tracking relay.** The operator-supplied CAPI endpoint was validated by *scheme only*, so `https://169.254.169.254/…` (cloud instance credentials) passed — and the CAPI token was appended to the URL, handing it to whatever answered. Now resolve-and-reject on private/loopback/link-local/CGNAT, token in a header, `redirect: 'manual'`. My own test caught a bypass in my first fix (IPv4-mapped IPv6 in hex form). 15/15.
- **Every redirect rule was dead** on the `/f/` surface — `Location: /new` resolved to the *admin SPA*, not the funnel. Fixed and verified live.
- **The 429 was cacheable** — an outage during exactly the ad burst you're paying for. Now `no-store`, verified at request 241.
- **Redirect footguns**: `from_path === to_path` (infinite loop) and a `/` prefix rule (swallows the whole funnel) were both accepted. Now refused.

### The one architectural item I did NOT change unilaterally
**Funnels are served on your admin origin** (`puure-dashboard.onrender.com/f/<slug>`) with no host gating. Consequences: unlaunched funnels are publicly reachable by slug; SEO duplicate content against your real domain; every connected custom host also mirrors every other funnel via `/f/`; and — most seriously — **operator-authored raw HTML/JS blocks execute same-origin with the CRM dashboard and its session** (CSP is disabled globally). Your friend's design makes an attached host the *only* door for exactly this reason. Fixing it means host-gating `/f`, which is a deploy-affecting change I won't make at 3am unreviewed. **Recommend doing this before the funnel surface is enabled for real traffic.**

## PROCESS NOTE

Every subsystem went: build → verify by execution → **independent adversarial review** → fix → merge → re-run all harnesses. The review gate caught things no per-branch check could: the three money-seam bugs and the forced-charge exploit only exist *between* subsystems. One audit finding (`no-store` missing) was itself a **false positive** — caused by a source file containing raw NUL bytes that made git and grep treat it as binary, meaning that file's diffs were invisible in every review all night. That is now fixed, which is arguably the most valuable single line changed tonight.
