# QUARANTINE — scripts `npm test` skips, and why

The runner (`server/tests/run-all.mjs`) reads this file. Every line of the form

```
- `relative/path.mjs` — reason
```

is skipped with a visible `SKIP` and its reason. Paths are relative to
`server/tests/`. A quarantine entry that points at a script that no longer
exists makes the runner **exit 2** — a stale entry is a maintenance bug, not a
free pass.

Quarantine is a debt register, not a bin. Every entry below names the condition
that would let it come back.

**Session B2 (2026-09-10) closed Q1: 37 entries in, 4 out.** See the before/after
table at the bottom.

---

## Q1 — imports source from an absolute path OUTSIDE this repository (0) — CLOSED

37 scripts used to `import` production source and `node_modules` from other
clones on one particular Mac (`/Users/ludo/Mineblock-LLC/...`,
`/Users/ludo/Puure-integrator/...`, `/Users/ludo/funnel-os/...`). They could
never run on a CI runner, and when they passed locally they proved something
about *another working copy*.

**35 of the 37 were repaired in session B2** and now resolve against this
checkout, by path relative to the test file:

* 30 scripts carried `const NM = '/Users/ludo/Mineblock-LLC/node_modules';`.
  That one line is now
  `const NM = new URL('../../../node_modules', import.meta.url).pathname.replace(/\/$/, '');`
  — the same house pattern `abandoned/route.mjs` and `integrations/klaviyo.mjs`
  already used for `ROOT`.
* 4 `money-path/*` scripts imported Puure-integrator source; each
  `await import('/Users/ludo/Puure-integrator/server/src/X')` is now
  `await import(new URL('../../src/X', import.meta.url))`.
* `money-path/review-regression.mjs` had four references: a static
  `postgres` import (now the bare specifier `'postgres'`, as every healthy
  script does), two dynamic source imports (now `new URL(...)`), and one import
  inside an `execSync` child eval, which now interpolates
  `${new URL('../../src/services/moneySweeps.js', import.meta.url).href}` so the
  child resolves against this checkout too.

No assertion and no file under `server/src` was changed. `grep -rn
'/Users/ludo/\(Mineblock-LLC\|Puure-integrator\|funnel-os\)' server/tests` is
now empty except for the two generators in Q3.

The 2 that were not repaired, and the 2 that were repaired but still fail, are
in Q2 and Q3 below with their new, precise reasons.

## Q2 — needs credentials, a live service, or a harness this script does not start (3)

- `brief-pipeline/golden.mjs` — refuses to start without `EMAIL`/`PASSWORD` (or `PUURE_EMAIL`/`PUURE_PASSWORD`): it logs in to a running dashboard. Comes back when it is split into a pure golden-fixture comparison plus a separately-gated live probe.
- `money-path/review-regression.mjs` — imports are fixed and it now loads this repo's source, but it drives an externally-started harness: `http://127.0.0.1:4003` plus a mock Stripe on `:4009` and a mock Whop on `:4010`, none of which the script boots. Observed on 2026-09-10 with the imports fixed and a fresh database: `TypeError: fetch failed` at the first `post()`, before any assertion. Comes back when it boots its own harness (as `money-path/upsell-page.mjs` boots its mock Whop) or when the runner grows a fixture-server hook.
- `money-path/upsell-page.mjs` — imports are fixed; **46 of 49 assertions pass**. The 3 that fail need REAL read-only Shopify pricing, which its own header says comes from `~/.config/puure/shopify.env`: `FAIL 2. original price == live Shopify ($89)` (`original_price: null`), `FAIL 2. discount_pct computed server-side` (`pct=null`), `FAIL 2. image is an https Shopify url` (empty). A lane may not call a live service, so this was not run with credentials. Comes back when the Shopify price lookup is stubbed behind a fixture, leaving the live call to a separately-gated probe.

## Q3 — not a test (4)

- `hub-sso/next-forms.mjs` — a shared FIXTURE LIST (W6c / R10 P0-1): the `next` forms every guard must refuse, imported by `hub-sso/hub-sso.mjs`. It exports data and asserts nothing, so running it on its own reports a green that means nothing — the same reason `brief-pipeline/golden.fixtures.mjs` is here. Its twin lives in the hub repo at `test/next-forms.mjs`, where the glob is `test/*.test.mjs` and the problem does not arise. Comes back if it ever grows assertions; the durable fix is the same one named above, move fixtures out of the `*.mjs` discovery glob.
- `brief-pipeline/golden.fixtures.mjs` — a fixture module imported by `golden.mjs`. It exits 0 without asserting anything, so running it reports a green that means nothing. Comes back if it ever grows assertions; the durable fix is to move fixtures out of the `*.mjs` discovery glob.
- `live-view/gen-centroids.mjs` — a one-shot GENERATOR, not a test: zero assertions, it writes `client/src/pages/live/countryCentroids.js` to stdout and that output is committed. Its input, the Natural Earth `world110m.json` TopoJSON, is **not in this repository** (it was read from the funnel-os checkout), so the import could not be made repo-relative. Comes back only if the fixture is vendored in AND the script grows assertions; the durable fix is to move generators out of the `*.mjs` discovery glob.
- `live-view/gen-land.mjs` — same: a one-shot generator for `client/src/pages/live/worldLand.js`, zero assertions, same missing `world110m.json` input. Same condition for return.

## Q4 — a real, pre-existing failing assertion on `origin/main` (1)

- `orders/post-purchase-ui.mjs` — `FAIL U8 the dunning page is in the sidebar under orders:access` (32 passed, 1 failed). Reproduced on a clean `edc1030` checkout, so it is not caused by this lane. The assertion is about the client sidebar, under `client/`, which Lane B may not touch. Comes back the moment U8 is fixed — this entry is the only thing keeping `npm test` from being red on arrival.

---

## Q1 before / after (session B2, 2026-09-10)

Every one of the 37 was run as-is first. `before` was measured with the three
out-of-repo roots made unresolvable, which is the state of a CI runner: all 37
died at import, exit 1, before a single assertion. `after` is the same script
with its imports repaired, run again.

| # | script | before | after |
|---|---|---|---|
| 1 | `abandoned/route.mjs` | ERR_MODULE_NOT_FOUND `Mineblock-LLC/node_modules/express` | **PASS** |
| 2 | `ai-generate/route-stream.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 57 assertions |
| 3 | `builder-metrics/metrics-ui.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 40 |
| 4 | `builder/variant-search.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 94 |
| 5 | `clone-page/scan-create.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 92 |
| 6 | `clone-page/shopify-import.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 382 |
| 7 | `costs/assistant-migrate.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 10 |
| 8 | `costs/assistant.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 270 |
| 9 | `funnel-settings/commerce.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 312 |
| 10 | `funnel-settings/domains-tab.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 58 |
| 11 | `funnel-settings/patch-settings.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 22 |
| 12 | `funnel-settings/themes.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 162 |
| 13 | `funnel-settings/tracking-tab.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 19 |
| 14 | `funnels/page-thumbnails.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 27 |
| 15 | `integrations/klaviyo.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 53 |
| 16 | `live-view/gen-centroids.mjs` | ENOENT `funnel-os/…/world110m.json` | still quarantined → **Q3** (generator, fixture not in this repo) |
| 17 | `live-view/gen-land.mjs` | ENOENT `funnel-os/…/world110m.json` | still quarantined → **Q3** (generator, fixture not in this repo) |
| 18 | `money-path/order-bump.mjs` | ERR_MODULE_NOT_FOUND `Puure-integrator/server/src/app.js` | **PASS** |
| 19 | `money-path/review-regression.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | imports fixed; still quarantined → **Q2** (`fetch failed`, needs the `:4003`/`:4009`/`:4010` harness) |
| 20 | `money-path/seam-fixes.mjs` | ERR_MODULE_NOT_FOUND `Puure-integrator/…/app.js` | **PASS** |
| 21 | `money-path/session-auth.mjs` | ERR_MODULE_NOT_FOUND `Puure-integrator/…/app.js` | **PASS** |
| 22 | `money-path/shopify-order-create.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 66 |
| 23 | `money-path/shopify-refund-reflect.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 35 |
| 24 | `money-path/split-arm-page-guard.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 42 |
| 25 | `money-path/split-delivery.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 33 |
| 26 | `money-path/tracking-wiring.mjs` | ERR_MODULE_NOT_FOUND `Puure-integrator/…/app.js` | **PASS** |
| 27 | `money-path/upsell-page.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | imports fixed, 46/49 pass; still quarantined → **Q2** (3 assertions need live Shopify pricing) |
| 28 | `orders/dunning.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 87 |
| 29 | `orders/order-edit.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** |
| 30 | `orders/orders-extras.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 150 |
| 31 | `page-types/page-types.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** |
| 32 | `tracking/admin-crud.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 44 |
| 33 | `tracking/delivery-patches.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 47 |
| 34 | `tracking/device-geo.mjs` | ERR_MODULE_NOT_FOUND `…/postgres` | **PASS** 84 |
| 35 | `tracking/extras-e2e.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** |
| 36 | `tracking/google-adapter.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** 144 |
| 37 | `tracking/s2s-integrations-e2e.mjs` | ERR_MODULE_NOT_FOUND `…/express` | **PASS** |

**33 un-quarantined · 2 stay for a live-service reason (Q2) · 2 stay as
generators with a fixture that is not in this repo (Q3).**

---

## Not quarantined, but you need to know

* **A stale `puure_shoporder` fails six of the newly-restored scripts, and it
  is not their fault.** `server/src/services/checkoutSchema.js`
  `ensureCheckoutTables()` is create-only: it declares the full `co_sessions`
  column list inside `CREATE TABLE IF NOT EXISTS` and then builds
  `idx_co_sessions_last_failed_payment` on one of those columns, with **no
  `ALTER TABLE … ADD COLUMN`**. On a machine whose scratch `co_sessions`
  predates those columns, the index statement throws
  `PostgresError: column "last_failed_payment_id" does not exist` (SQLSTATE
  42703) before any assertion runs, and the `/orders/:id/journey` route 500s.
  Proven on 2026-09-10 both ways in a throwaway database: from empty,
  `ensureCheckoutTables: OK` and the column is present; after dropping just that
  column, the identical call throws 42703. Proven again against the scripts: all
  six (`funnel-settings/commerce.mjs`, `money-path/shopify-order-create.mjs`,
  `money-path/shopify-refund-reflect.mjs`, `orders/orders-extras.mjs`,
  `tracking/delivery-patches.mjs`, `tracking/google-adapter.mjs`) pass on a
  fresh database and fail on the stale one.

  This Mac's `co_sessions` had **18 of the 31 declared columns**. It was
  repaired additively (no data loss, nothing dropped):

  ```sql
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS last_failed_payment_id TEXT;
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS payment_method_id      TEXT;
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS tracking_net           JSONB;
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS click_vault            JSONB;
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS import_status          TEXT;
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS import_due_at          TIMESTAMPTZ;
  ALTER TABLE co_sessions ADD COLUMN IF NOT EXISTS needs_review_reason    TEXT;
  ```

  Run that on any machine where a restored script dies with 42703. **The durable
  fix is the same additive `ALTER` inside `ensureCheckoutTables()`** — an R6
  concern ("a migration that cannot run on an empty database is a bug"; this is
  its mirror image, an ensure that cannot run on an existing one). That file is
  under `server/src` and is not Lane B's to edit. **Open item for the lead.**

* **The suite needs scratch databases nobody creates.** 22 scripts share a
  `puure_shoporder` database and `split/statistics.mjs` needs `puure_split`;
  none of them creates it, so on a clean machine they die with
  `database "..." does not exist`. The runner now provisions every role and
  database named by a DSN inside the scripts it is about to run (local clusters
  only) — see `preflight()` in `run-all.mjs`. Restoring the 33 added five more
  databases to that set: `puure_upsell`, `puure_orderedit`, `puure_pagetypes`,
  `puure_tracking_extras`, `puure_s2s_networks` (plus `puure_dunning`).
* **58 scripts hardcode `postgres://puure@127.0.0.1:5433/<db>`** instead of
  reading the environment. `PGURL` is exported to every child process and is
  what the preflight provisions against, but the scripts themselves still ignore
  it. Making them read `PGURL` is a follow-up slice.
* **The client toolchain is a hard dependency of four scripts**
  (`ai-media/dialog-dom.mjs`, `live-view/run-*.mjs`): they need
  `client/node_modules` (vite/rollup), and `dialog-dom.mjs` additionally needs a
  Playwright Chromium. CI installs both. Locally, `cd client && npm ci` first.
* **Gaps the smoke suite could not fill — orders is now closed, product
  profiles is not.** Three of the four `orders/*` scripts are runnable again, so
  smoke now carries real orders coverage (`orders/orders-extras.mjs`). There is
  still **no test anywhere in the repo for product profiles** even though
  `server/src/routes/productProfiles.js` exists and migration 017 depends on the
  table, so that gap stands.
