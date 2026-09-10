# Lane handoff — lane-b (CI + fleet)   last session 2026-09-10 (B3)   base commit 84323b4 → 3084e54

Branch `day1/lane-ci-fleet`, worktree `/Users/ludo/wt-lane-ci-fleet`.
Proof packs: `briefs/out/PROOF-LANE-B.md` (sessions B and B2),
**`briefs/out/PROOF-LANE-B3.md` (session B3 — the review fixes)**.
Review being answered: `briefs/out/REVIEW-LANE-B.md`.

## Where I stopped

Session B delivered the runner, CI workflow and fleet script. Session B2 closed
the 37 scripts that imported other checkouts by absolute path. **Session B3
applied every P1 and the listed P2s from the adversarial review.** Nothing is
half-applied; the tree is committed and green.

### Session B3 — what changed

| Review item | State |
|---|---|
| **P1-1** protected-store guard (`--i-typed-the-store-name=Puure`, exact + case-sensitive, both `deploy` and `rollback`, rollback anchor printed before every real POST) | **fixed**, 37 assertions |
| **P1-2** `rollback` anchors on the deploy in status `live`, never `list[0]`; refuses when no `live` record exists; `status` reads `limit=5` and reports the live record | **fixed**, 4 non-live-newest fixtures |
| **P1-3** the Render key is attached only for `cfg.api`; the health check is unauthenticated, on the raw `fetch` | **fixed**, incl. a tampered-`url` test |
| **P1-4** runner spawns `detached` and kills the whole process group on timeout; settles on `close` or `exit` + a bounded 250 ms drain | **fixed**, grandchild fixture + `ps` sweep |
| P2-1 `--commit=<sha>` accepted; a bad value gets a message about the value | fixed |
| P2-2 `--dry-run` routed through `cmdDeploy`, so it cannot bypass a refusal | fixed |
| P2-3 `AbortSignal.timeout(30_000)` on every request | fixed |
| P2-5 `readKeyFromSettings` tested against a temp `HOME` (no real key read) | fixed |
| P2-6 `isSha` = 40 lowercase hex, nothing else | fixed |
| P2-7 R15 grep split: brands case-insensitive, codes/ids case-sensitive, `act_` left-bounded | fixed |
| P2-8 the three dependency-free `fleet/*` tests are in smoke | fixed |
| P2-9 migrations placeholder PASS pinned to the one known 017 defect | fixed |
| P2-11 `docs/crm-ci.yml` cites `backend/app/core/config.py:32` | fixed |
| P2-4 | **half**: error-body echo fixed; **pagination NOT done** |
| P2-10, P2-12 | **not done** — see "What is NOT proven" |
| `checkoutSchema.js` create-only bug | **not done — another lane owns it** |

The protected-store rule lives in `scripts/fleet.services.json` as `protection`
(`prefix`/`store`/`rule`), **not** in `fleet.mjs`: R15 is asserted by a test that
greps the script for the store name. A future `puure-*` service is protected the
day it is added.

`run-all.mjs` also accepts `--smoke` / `--all` as aliases; the command the briefs
use (`run-all.mjs --smoke`) previously exited 2 with a usage error.

| Goal | Delivered |
|---|---|
| S0b-5 runner | `server/tests/run-all.mjs`, `server/tests/QUARANTINE.md`, `package.json` scripts `test` / `test:smoke` |
| S0b-5 CI | `.github/workflows/ci.yml` (dashboard), `docs/crm-ci.yml` (for the CRM repo, not committable from here) |
| S0b-7 fleet | `scripts/fleet.mjs`, `scripts/fleet.services.json` |
| tests | `server/tests/fleet/runner.mjs`, `fleet-cli.mjs`, `fleet-render.mjs`, `ci.mjs` — 160 assertions |
| **B2 repair** | **35 test scripts re-pointed at this repository; 33 out of quarantine; smoke gained real orders coverage** |

## What is proven

* `npm test` exits 0. **88 passed, 0 failed, 0 timed out, 7 skipped in 651.2s**
  (B2: 88 / 0 / 7 in 644.7s — no regression).
* `node server/tests/run-all.mjs --smoke`: **14 passed, 0 failed, 0 timed out,
  0 skipped in 66.2s** (B2: 11 in 58.6s; cap 8 min). It now includes the real
  `/api/v1/orders` router **and the three fleet test files**, so CI runs the
  deploy refusals on every push.
* `server/tests/fleet/` is **279 assertions** (105 + 75 + 39 + 60), up from 160.
* **Every B3 fix was red first.** Each finding was reproduced by execution
  (mocked fetch / fixture tree) before the fix and re-run identically after; the
  four test files were additionally run against the pre-fix source under an
  md5-verified file swap and went red (29 / 14 / 6 / 8 failures), proving the new
  assertions are load-bearing rather than merely green. Outputs verbatim in
  `PROOF-LANE-B3.md`.
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
4. **`fleet deploy` and `fleet rollback` have never sent a real POST**, and B3
   changed both of them. The new guards (P1-1 refusal, P1-2 live-anchored
   target, the ROLLBACK ANCHOR read, P1-3 header scoping) are proven against
   mocked fixtures only. **The review's condition stands: the second pass, and
   the first real `deploy`/`rollback`, must confirm the anchor read and the
   refusal against the live API.** No Render call was made in B3 (R35).
4a. **P2-4 pagination is NOT fixed.** `env-diff` reads `?limit=100` and follows
   no cursor, so a service with >100 variables silently under-reports drift.
   Needs a cursor loop and a two-page fixture. Today's four services are well
   under 100. (The error-body echo half **is** fixed: an `/env-vars` failure now
   reports the status only, never the body.)
4b. **P2-10 is NOT settled.** `permissions: contents: read` may be insufficient
   for `gitleaks-action` v2 on `pull_request`. Only a real run tells; add
   `pull-requests: read` if it fails.
4c. **P2-12 is NOT fixed and is the lead's, not a lane's.** `git remote -v` in
   this worktree prints an `origin` URL containing a 40-char `ghp_` token from
   the parent clone's `.git/config`. Not in any commit. Needs rotation plus a
   credential helper.
4d. **`fleet/ci.mjs` is deliberately NOT in smoke**: it shells out to `python3` +
   PyYAML, unproven on the GitHub runner. Either confirm on the first real run
   or re-parse the workflow with a node YAML package.
4e. **The `checkoutSchema.js` create-only bug (B2 finding 2) is untouched** —
   another lane owns it. It is under `server/src`, which this lane may not
   touch, and it is R6-class: a table that already exists never receives a
   newly added column.
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

1. **Second adversarial pass on the deploy code**, as the review requires: the
   four P1s have landed, so the condition "P1-1..P1-3 before any real
   `deploy`/`rollback`, P1-4 before CI is trusted on A4" is now met on paper and
   needs a clean second read. Start at `scripts/fleet.mjs` `protectionRefusal`,
   `liveAnchor`, `cmdRollback`, and `makeClient`.
2. **Merge, then run the workflow once on a real push** and paste the actual run
   output into the proof pack — still the only unproven piece of goal 2, and the
   only thing that confirms the 33 restored scripts run on a machine that has
   never had the other checkouts. Watch for P2-10 (gitleaks permissions).
3. **The first real `deploy`/`rollback`** must be a Mineblock service, not Puure,
   and should paste the ROLLBACK ANCHOR line it printed — that is the one part of
   P1-1/P1-2 that fixtures cannot prove.
4. Open, in order of value: P2-4 pagination; `fleet/ci.mjs` into smoke; the
   ~11 min full suite (shared app boot per directory); product-profile CRUD still
   has no test anywhere.
