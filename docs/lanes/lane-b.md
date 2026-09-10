# Lane handoff — lane-b (CI + fleet)   last session 2026-09-10 (B2)   base commit 75192b1 → 81091f8

Branch `day1/lane-ci-fleet`, worktree `/Users/ludo/wt-lane-ci-fleet`.
Proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-B.md` (session B2 is the
second half of that file).

## Where I stopped

Session B delivered the runner, CI workflow and fleet script. **Session B2 closed
its biggest finding**: the 37 test scripts that imported other checkouts by
absolute path. Nothing is half-applied; the tree is committed and green.

| Goal | Delivered |
|---|---|
| S0b-5 runner | `server/tests/run-all.mjs`, `server/tests/QUARANTINE.md`, `package.json` scripts `test` / `test:smoke` |
| S0b-5 CI | `.github/workflows/ci.yml` (dashboard), `docs/crm-ci.yml` (for the CRM repo, not committable from here) |
| S0b-7 fleet | `scripts/fleet.mjs`, `scripts/fleet.services.json` |
| tests | `server/tests/fleet/runner.mjs`, `fleet-cli.mjs`, `fleet-render.mjs`, `ci.mjs` — 160 assertions |
| **B2 repair** | **35 test scripts re-pointed at this repository; 33 out of quarantine; smoke gained real orders coverage** |

## What is proven

* `npm test` exits 0. **88 passed, 0 failed, 0 timed out, 7 skipped in 644.7s**
  (was 55 passed / 40 skipped in 322.8s on `75192b1`).
* `npm run test:smoke`: **11 passed, 0 failed, 0 skipped in 58.6s** (cap 8 min),
  and it now includes the real `/api/v1/orders` router.
* Every one of the 37 was run as-is first, with the three out-of-repo roots made
  unresolvable — a CI runner's state, control-tested in both directions. All 37
  exited 1 at import before any assertion. Per-file before/after table is in
  `server/tests/QUARANTINE.md`.
* The one-line repair was proven red → green on `tracking/admin-crud.mjs` with
  an identical check before applying it to 29 more files.
* A seeded failing assertion turns the run red and is named; a hanging script is
  killed at its header timeout and reported `TIMEOUT`.
* The R15 guard is proven by executing the workflow's own `run:` script against
  fixture trees — red with a brand literal, green without, green when the guarded
  directories do not exist.
* `fleet deploy` without `--commit` (and with a ref instead of a sha) is refused
  at exit 2 **before** any network call; `--dry-run` prints the exact POST body
  and sends nothing; the API key travels only in an `Authorization` header.
* One real read-only `fleet status` call was made (session B).

## What is NOT proven

1. **Nothing has run on a GitHub runner.** The claim that the 33 restored scripts
   work in CI rests on them resolving only in-repo paths and passing under a
   guard that makes the out-of-repo roots unresolvable. Strong signal, not a
   green CI run. Still the single biggest open item.
2. **`docs/crm-ci.yml` has never been executed.** `/Users/ludo/funnel-os` is out
   of bounds. Whoever copies it into the CRM repo must paste the real output back.
3. **`fleet env-diff` has never hit Render.** A10 is proven against
   `discovery/env-inventory.md` §3.1 as fixture data: 24 + 7 = **31** asymmetric
   keys. ⚠ The live number is probably **29** today — `COORDINATION.md` records
   `PUURE_DATABASE_URL` removed from mineblock-dashboard and
   `SHOPIFY_WEBHOOK_SECRET` set on puure-dashboard on 2026-09-10.
4. **`fleet deploy` and `fleet rollback` have never sent a real POST.**
5. **`money-path/upsell-page.mjs` was never run with Shopify credentials**, so
   "46 of 49 pass" is the credential-less number.
6. **`money-path/review-regression.mjs` was never run with its harness up**, so
   only its import fix is proven, not its assertions.

## What I found (this is the part worth reading)

1. **The 37 are down to 4, and the reasons are now precise.** 33 run. Two need a
   live service (`review-regression` wants a harness on `:4003`/`:4009`/`:4010`
   it never boots; `upsell-page` needs real Shopify pricing for 3 of 49
   assertions). Two were never tests at all — `live-view/gen-centroids.mjs` and
   `gen-land.mjs` are one-shot generators with zero assertions whose committed
   output is already in `client/src/pages/live/`, and whose `world110m.json`
   input is not in this repository. They moved Q1 → Q3.
2. **`ensureCheckoutTables()` cannot heal an existing table, and that is a real
   bug.** `server/src/services/checkoutSchema.js` declares the whole
   `co_sessions` column list inside `CREATE TABLE IF NOT EXISTS`, then builds an
   index on one of those columns, with no `ALTER TABLE … ADD COLUMN`. A scratch
   table that predates a column can never gain it, so every consumer dies at
   `42703 column "last_failed_payment_id" does not exist` — naming a column the
   code plainly declares. This is R6's mirror image. Reproduced on demand both
   ways in a throwaway database. **It needs an owner: `server/src` was out of
   bounds for this slice.**
3. **Six of the eight first-run failures were the stale scratch database, not
   the scripts.** All six pass on a fresh database. `puure_shoporder` on this Mac
   was 13 columns out of date. It was repaired **additively** (`ADD COLUMN IF NOT
   EXISTS` × 7, nothing dropped); the SQL is in `QUARANTINE.md`.
4. **The scratch databases are long-lived and drift.** `puure_shoporder` is
   shared by 22+ scripts and had 44 tables / ~126 rows of accumulated test junk.
   CI always gets a fresh one, so CI and local disagree — the same class of bug
   this slice just removed. A nightly recreate or a preflight staleness check
   would close it. Deliberately not done here: the lane preamble forbids touching
   a database this lane did not create, and the sandbox refused `DROP DATABASE`.
5. **`orders/orders-extras.mjs:297` uses `d.entries` where every neighbouring
   line uses `d?.entries`**, so a 500 from `/api/v1/orders/:id/journey` surfaces
   as an uncaught `TypeError` instead of a named `FAIL`. One character. Not
   changed — the brief forbids assertion edits.
6. **The full suite is now a ~11 min job** (323 s → 645 s) and will grow. Most of
   it is 33 scripts each spending ~11 s booting Express against Postgres.
   Sharing one app boot per directory is the obvious next slice. `test:smoke` is
   the pre-merge gate at 58.6 s and is fine.
7. **Still no test anywhere for product profiles**, although
   `server/src/routes/productProfiles.js` exists and migration 017 depends on the
   table. Smoke could not cover product-profile CRUD in session B and still
   cannot. **Orders coverage is now real** (`orders/list` → `orders-extras.mjs`).
8. **58 scripts still hardcode `postgres://puure@127.0.0.1:5433/<db>`** and
   ignore `PGURL`. Unchanged from session B; a follow-up slice.
9. **`server/migrations/run.js` does not implement `--help`**, and migrations
   cannot run on an empty database — they stop at
   `017_create_spy_custom_images.sql` with `relation "product_profiles" does not
   exist`. R6 violation, Lane A's slice. The smoke placeholder passes on both
   today's defect and Lane A's fix, and fails on anything else.
10. **`ai-media/dialog-dom.mjs` runs close to the default timeout** (36.8 s /
    53.6 s / 53.7 s / 58 s against 120 s). Not in smoke, so CI is not exposed.
    The fix is one header comment in a file this lane does not own.
11. **`ai-media/dialog-dom.mjs` leaves `client/.tmp-aimedia-dom/` behind.**
12. **Render says `puure-crm` is still live on `1466078`** — the pill-colour leak
    commit, finished `2026-09-09T15:53:14Z`. The rollback recorded as "pending
    Ludo's typed authorisation" has not happened. Not this lane's call.

## Open questions for the lead

1. **Who owns the `checkoutSchema.js` additive-ALTER fix (finding 2)?** It is
   under `server/src`, it is an R6-class bug, and it will bite again the next
   time a column is added.
2. `docs/crm-ci.yml` needs an owner with commit rights on the CRM repo.
3. Product-profile CRUD still has no test. Slice, or accept the gap?
4. Should the scratch databases be recreated nightly, or should the runner's
   preflight detect a stale one (finding 4)?
5. CI installs with `npm ci --ignore-scripts` (skips the Playwright download).
   Right for smoke, wrong the day a browser test enters CI.
6. Is a ~11 min full suite acceptable, or is the shared-app-boot slice (finding
   6) worth doing before more scripts come back?

## Next action for the next session

Merge this branch, then run the workflow once on a real push and paste the actual
run output into the proof pack — that is still the only unproven piece of goal 2,
and it is now also the only thing that would confirm the 33 restored scripts run
on a machine that has never had the other checkouts.
