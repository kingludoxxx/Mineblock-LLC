# Lane handoff — Lane F (S1-5 Constants to manifest)   last session 2026-09-10   commit 3fa46a3

Branch `day1/lane-constants` in `/Users/ludo/wt-lane-constants`, from hub/main edc1030. 14 commits, one per scope item. Proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-F.md`.

## Where I stopped (exact step)
All twelve scope items are committed with tests written first. Last commit 3fa46a3 (item 12, client brand.js). Nothing pushed, nothing deployed, no live service called.

## The module
`server/src/config/storeConfig.js` — the ONE read site for store identity. Every getter reads `process.env` when CALLED (R7); nothing is cached but the "already warned" set. Unset/malformed → `null` / `[]` / `{}` / the documented non-store default, plus ONE warning naming the key. No brand, store, colour, ad-account, channel or domain literal in the file (the only literal defaults are `2024-01`, `v21.0`, `Europe/Madrid`).

Manifest seam: `setStoreConfigSource((key) => value | undefined)` — consulted first for every key, falls through to env. Wire the hub manifest there at boot; `null` removes it.

Getters and their env keys:
| getter | env | unset behaviour |
|---|---|---|
| `storeCode()` | `STORE_CODE` | null + warn |
| `brand()` | `BRAND_NAME`, `BRAND_SHORT_NAME`, `BRAND_LOGO_WHITE`, `BRAND_LOGO_SYMBOL`, `BRAND_LOGO_BLACK`, `BRAND_EMAIL_DOMAIN` | null per field, silent (client keeps its build-time fallback) |
| `shopifyStoreDomain()` | `SHOPIFY_STORE_DOMAIN` | null + warn (KPI sync dormant; /shopify-webhook/register 400) |
| `shopifyStoreUrl()` | `SHOPIFY_STORE_URL` | null + warn (ad launch without product URL → 400) |
| `shopifyApiVersion()` | `SHOPIFY_API_VERSION` | default `2024-01`; MALFORMED → null + warn (refused, never repaired) |
| `whopCompanyId()` | `WHOP_COMPANY_ID` | null + warn |
| `tripleWhaleShopId()` | `TRIPLEWHALE_SHOP_ID` | null + warn; every TW path returns [] / throws named error |
| `metaApiVersion()` / `metaGraphUrl()` | `META_API_VERSION` | default `v21.0`; malformed → default + warn |
| `adAccounts()` / `adAccountNames()` / `adAccountName(id)` | `META_AD_ACCOUNTS_JSON` `[{id:"act_…",name}]` | [] + warn; ids display raw |
| `frameioToken()` (SECRET, never in snapshot) | `FRAMEIO_TOKEN`; legacy `FRAME_IO_TOKEN`, `FRAMEIO_API_TOKEN` honoured with a deprecation warning | '' + warn |
| `slackChannels()` | `SLACK_PNL_CHANNEL`, `SLACK_KPI_CHANNEL`, `SLACK_REJECTION_CHANNEL`, `SLACK_EDITOR_CHANNELS_JSON` `{"<editor>":"C0…"}` | null / {} + warn; posts skipped, P&L report throws named error |
| `timezone()` | `REPORT_TZ` | default `Europe/Madrid`; invalid IANA → THROWS naming the key (money bucketing; same message funnelMetrics always raised) |
| `productCodes()` / `productFor(code)` / `defaultProduct()` / `productForClickupProductRef(ref)` | `PRODUCT_CODES_JSON` (shape documented in the module header) | {} + warn; pipelines dormant, `pipelineForProduct()` throws a named error |
| `snapshot()` | — | everything non-secret; = `GET /api/v1/store-config` body; = A2 snapshots |

Routes (`server/src/routes/storeConfig.js`, mounted in `routes/index.js` under `/api/v1`, announced in COORDINATION.md): `GET /api/v1/store-config` (authenticate; `Cache-Control: no-store`) and `GET /api/v1/brand` (public; `max-age=60`).

## The exact env values PL and MB must carry for unchanged behaviour
Checked in as **`server/config/env.MB.example`** and **`server/config/env.PL.example`** (non-secret; every value cites the file:line of the literal it replaces). The A2 test loads them and compares `snapshot()` to `server/tests/store-config/snapshots/{MB,PL}.json`. Summary:

MB (mineblock-dashboard): `STORE_CODE=MB` · `BRAND_NAME=Mineblock LLC` `BRAND_SHORT_NAME=Mineblock` `BRAND_LOGO_WHITE=/logo-white.png` `BRAND_LOGO_SYMBOL=/logo-symbol-white.png` `BRAND_LOGO_BLACK=/logo-black.svg` `BRAND_EMAIL_DOMAIN=mineblock.com` · `SHOPIFY_STORE_DOMAIN=17cca0-2.myshopify.com` `SHOPIFY_STORE_URL=https://mineblock.co` `SHOPIFY_API_VERSION=2024-01` · `WHOP_COMPANY_ID=biz_pkN7XmNrvouslh` · `TRIPLEWHALE_SHOP_ID=17cca0-2.myshopify.com` · `META_API_VERSION=v21.0` · `META_AD_ACCOUNTS_JSON=[{"id":"act_938489175321542","name":"Mineblock X8"},{"id":"act_1972517213693373","name":"Mineblock CC 4"},{"id":"act_1238893338181787","name":"Mineblock CC 5"},{"id":"act_25781501541499027","name":"Mineblock X6"}]` · `SLACK_PNL_CHANNEL=C0AF724MJPR` `SLACK_KPI_CHANNEL=C0AN0BPN0NA` `SLACK_EDITOR_CHANNELS_JSON={"Uly":"C0ANNMMPUCC","Dimaranan":"C0ARP2SBQ8J"}` · `REPORT_TZ=Europe/Madrid` · `PRODUCT_CODES_JSON` = MB (default; lists 901518716584 / 901518769479 / 901518769621; Frame.io 19c0ce1f… / 2eb1701e… / c9440b5e…) + PL (alias PUURE; list 901524484514; Frame.io b38fbf28… / 51ec2ac5…; namingCode PL; fbPage Puure) + P1 (list 901524484514; ClickUp productId 123yxuahe91; Frame.io b664289d… / 10abecc4…; namingCode P1) — verbatim JSON in the example file.

PL (puure-dashboard): `STORE_CODE=PL` · `BRAND_NAME=Puure` `BRAND_SHORT_NAME=Puure` `BRAND_LOGO_WHITE=/logo-puure-white.png` `BRAND_LOGO_SYMBOL=/logo-puure-symbol-white.png` `BRAND_LOGO_BLACK=/logo-puure-black.svg` `BRAND_EMAIL_DOMAIN=trypuure.co` · `SHOPIFY_STORE_DOMAIN=9jn59g-x7.myshopify.com` `SHOPIFY_STORE_URL=https://trypuure.co` `SHOPIFY_API_VERSION=2024-01` · `META_API_VERSION=v21.0` `META_AD_ACCOUNTS_JSON=[]` · `REPORT_TZ=Europe/Madrid` · `PRODUCT_CODES_JSON` = PL + P1 only (no default: unknown codes are refused). **Deliberately UNSET on PL** (today's code used MINEBLOCK's literal on the Puure deploy, which is the wrong-store default R5/R15 ban): `TRIPLEWHALE_SHOP_ID`, `SLACK_PNL_CHANNEL`, `SLACK_KPI_CHANNEL`, `SLACK_EDITOR_CHANNELS_JSON`, `WHOP_COMPANY_ID` (Puure's biz_ id is not visible in the repo). Set Puure's own values when they exist.

Both stores keep every EXISTING Render key (`SHOPIFY_ACCESS_TOKEN`, `META_AD_ACCOUNT_IDS`, `CLICKUP_MB_*`, `CLICKUP_PUURE_VIDEO_LIST_ID`, `FRAMEIO_MB_*`, `FRAMEIO_PUURE_*`, `SLACK_REJECTION_CHANNEL`, `FRAMEIO_TOKEN`, …): this lane only removed literal DEFAULTS; list-level ClickUp/Frame.io routing in clickupWebhook.js still reads those keys. The `VITE_BRAND_*` build keys stay until the runtime read has soaked.

Rollback of any item = unset the variable (R7): the feature goes dormant with one warning.

## What is proven (proof pack) and what is not
Proven by execution: 81/81 Lane F tests (unit, real-auth routes, A2 snapshots, wiring/A1, adLauncher 400, client brand); every unset/malformed path; the secret scan with its negative control; `vite build` of the client; the A5 set (13 existing tests green; 6 fail identically on the untouched baseline; 1 needs live creds; admin-crud green in isolation, 44/44).
Not proven: behaviour on a Render deploy with the example env (no deploys from a lane); the brand endpoint in a real browser (demo card step); Meta calls on v21.0 where adsReporting used v22.0 and staticsGeneration:4592 used v23.0 (fields used exist in v21.0 per the Graph changelog, but not executed here — set `META_API_VERSION=v22.0`/`v23.0` per store if the lead prefers zero drift).

## Deviations from the brief (each a DECISION MADE, flagged for the lead)
1. **A1 is 3, not 0** (verbatim in the proof pack): the sanctioned single `2024-01` default in storeConfig.js (item 4 mandates exactly one); a comment at `staticsGeneration.js:6712` (outside my line budget `:9352`/`:4592`); `domainHub/validate.js:25` (not a Lane F file). All three are pinned in `wiring.mjs` so any NEW leak fails.
2. **Files touched outside the named list, each one line + import, needed by an item's own acceptance:** `services/funnelAttribution.js:224` (a third `REPORT_TZ` read site the discovery missed — item 7 says "single read site"); `services/metaAdsApi.js` (in §6.4's list, doc-comment `act_123456` reworded); `routes/staticsGeneration.js` beyond the two named lines: the import line at the top and the guard/usage of the SAME `_TW_SHOP_ID` constant (:9373/:9378) — the constant at :9352 is meaningless without its one use. `routes/index.js` (+2 lines, announced in COORDINATION.md).
3. **`GET /api/v1/brand` returns null for unset `BRAND_*`**, not "the current VITE defaults": those defaults are `Mineblock LLC` / `mineblock.com`, i.e. brand literals R15 bans in server code and A1 greps for. The client keeps them as its build-time fallback (item 12), so the visible behaviour is unchanged.
4. **Malformed `SHOPIFY_API_VERSION` is REFUSED (null), not defaulted** — an existing test (clone-page/shopify-import n1) enforces that contract; fixed in fe63bfb after it went red.
5. **No legacy fallback for `PRODUCT_CODES_JSON`** (I did not synthesise it from `CLICKUP_MB_*`/`FRAMEIO_P1_*`): that would put MB/PL/P1 codes in engine code. Consequence: the brief push and the Frame.io folder auto-create are DORMANT until `PRODUCT_CODES_JSON` is set on each store — set it (from the example files) in the same env change that lands this branch.
6. **Frame.io third token name:** only `FRAMEIO_TOKEN` and `FRAME_IO_TOKEN` exist in the tree; `FRAMEIO_API_TOKEN` is accepted as the third name the brief mentions. Nothing in-tree uses it.
7. **`metaApiVersion` on adsReporting (v22.0 → v21.0) and staticsGeneration:4592 (v23.0 → v21.0)** — the brief asks for one env with default v21.0; per-store pin available via `META_API_VERSION`.
8. **staticsGeneration.js keeps three Meta pins** outside the line budget (`:7192`, `:9745`, `:10303`, v21/v22) — listed in the wiring test's allowlist for that file; and clickupWebhook.js keeps `FRAMEIO_LEGIT_PROJECT_NAMES || 'Mineblock LLC'` (:2194/:2449) and briefPipeline.js keeps `'MR'` naming defaults (:504, :4724) — brand/product literals from §6.8, not among the twelve items and not in A1.

## Open questions for the lead (not for Ludo)
- Do you want A1 literally 0? Then the `2024-01` default moves to a non-`server/src` file (5 lines), and the two out-of-lane residues need an owner.
- `PRODUCT_CODES_JSON` on the PL deploy: I gave PL no default entry (unknown codes refused). If puure-dashboard must keep "everything else → MB" semantics for stray MR briefs, add the MB entry to PL's env — I recommend not.
- Puure's `WHOP_COMPANY_ID`, `TRIPLEWHALE_SHOP_ID` and Slack channel ids are not visible in the repo; the PL example leaves them unset (dormant). Fill from Render when landing.
- `server/tests/brief-pipeline/golden.mjs` needs live credentials (`EMAIL/PASSWORD`) on baseline too — not a lane-runnable test.

## Next action for the next session (one line)
Lead: review the 14 commits, set the `env.{PL,MB}.example` keys on the SANDBOX services (PRODUCT_CODES_JSON included), deploy with an explicit commitId (R37), hit `GET /api/v1/store-config` and diff it against `snapshots/<store>.json`.

---

# Lane F2 — adversarial-review fixes (2026-09-10)

Branch rebased onto `hub/main` **95fc741**. Pre-rebase tip kept at `backup/lane-constants-pre-f2`.
Proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-F2.md`. 911 tests green (97 Lane F + 814 existing).

| review item | commit | what changed |
|---|---|---|
| **P1-1** fail-OPEN on unset `PRODUCT_CODES_JSON` | `3ad369d` | the key is now REQUIRED. `productCodes()` throws `StoreConfigError` on unset / blank / malformed / two defaults / empty `{}`; `assertBootConfig()` runs as step 0 of `server.js start()` and `process.exit(1)`s with a named, actionable error. |
| **P1-2** Meta version unification | `3ad369d` + `b53e62d` | `META_API_VERSION_DEFAULT` v21.0 → **v23.0**; the last three Graph pins in `staticsGeneration.js` (`:7184`, `:9737`, `:10295`) read `storeConfig.metaGraphUrl()`; `env.{PL,MB}.example` pin v23.0. `git grep -nE "graph\.facebook\.com/v[0-9]" -- server/src` is now **0** (was 3). |
| **P2-1** Slack null channel | `e132273` | `sendSlackAlert()` returns when the P&L channel is null instead of POSTing `{"channel": null}`. Exported so it is testable. |
| **P2-3** PL had no default product | `b53e62d` | `env.PL.example` marks PL's own `PL` entry `"default": true` — unknown codes resolve to the store's OWN pipeline, never another store's, never a mid-request throw. MB unchanged. |

## Deviations 5 and 7 above are now SUPERSEDED
- **Deviation 5** said the ClickUp/Frame.io pipelines are "DORMANT until `PRODUCT_CODES_JSON` is set".
  They were not dormant, they were misrouted (the reviewer proved it). They are now a **boot refusal**.
- **Deviation 7** (v21.0 default) is replaced by v23.0.

## HARD PRECONDITION for the lead
`PRODUCT_CODES_JSON` must be set on **every** service in the same env change as, or **before**,
the deploy of this branch. After this commit a service without it **will not start** — that is
the intended behaviour, and it is the reason the ordering is no longer a preference.

## Still open after F2
- **P2-2** (not done, deliberately): seven Shopify call sites produce `…/admin/api/null/…` → 404
  instead of a clear `shopify_not_configured` when `SHOPIFY_API_VERSION` is malformed
  (`orders.js:332`, `:650`, `abandonedCheckouts.js:199`, `funnelCommerce.js:201`,
  `checkoutPricing.js:96`, `checkoutDiscount.js:41`, `shopifyOrderCreate.js:238`). Cosmetic per
  the reviewer, spans other lanes' files, needs its own slice. Behaviour is already safer than
  baseline (the malformed value is refused, not interpolated into a path).
- **Meta v23.0 field check** — cannot be done from a lane. Before deploying, confirm
  `adsReporting`'s FIELDS and `staticsGeneration`'s `creative{image_url,thumbnail_url}` at v23.
- **A1 residues 1-3** unchanged and still pinned in `wiring.mjs` in both directions.

## Next action for the next session (one line)
Lead: review `e132273`, `3ad369d`, `b53e62d` on top of the rebase; set the `env.{PL,MB}.example`
keys (PRODUCT_CODES_JSON FIRST) on the SANDBOX services, deploy with an explicit commitId (R37),
confirm the boot log line `Store config OK (PRODUCT_CODES_JSON)`, then hit
`GET /api/v1/store-config` and diff against `snapshots/<store>.json`.
