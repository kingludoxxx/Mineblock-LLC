# Lane handoff — lane-b (CI + fleet)   last session 2026-09-10   base commit edc1030

Branch `day1/lane-ci-fleet`, worktree `/Users/ludo/wt-lane-ci-fleet`.
Proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-B.md`.

## Where I stopped

All three goals are delivered, committed and green. Nothing is half-applied.

| Goal | Delivered |
|---|---|
| S0b-5 runner | `server/tests/run-all.mjs`, `server/tests/QUARANTINE.md`, `package.json` scripts `test` / `test:smoke` |
| S0b-5 CI | `.github/workflows/ci.yml` (dashboard), `docs/crm-ci.yml` (for the CRM repo, not committable from here) |
| S0b-7 fleet | `scripts/fleet.mjs`, `scripts/fleet.services.json` |
| tests | `server/tests/fleet/runner.mjs`, `fleet-cli.mjs`, `fleet-render.mjs`, `ci.mjs` — 152 assertions |

## What is proven

* `npm test` runs the whole tree and exits 0; `npm run test:smoke` runs 10 curated entries in **47 s** (cap was 8 min).
* A seeded failing assertion turns the run red and is named; a hanging script is killed at its header timeout and reported `TIMEOUT`, not left to hang CI.
* The R15 guard is proven by executing the workflow's own `run:` script against fixture trees — red with a brand literal, green without, green when the guarded directories do not exist.
* `fleet deploy` without `--commit` (and with a ref instead of a sha) is refused at exit 2 **before** any network call; `--dry-run` prints the exact POST body and sends nothing; the API key travels only in an `Authorization` header and is scrubbed from every printed line.
* One real read-only `fleet status` call was made. Its four rows agree with the deploy log in `COORDINATION.md`.

## What is NOT proven

1. **`docs/crm-ci.yml` has never been executed.** It is valid YAML and reviewed against the CRM env inventory, but `/Users/ludo/funnel-os` is out of bounds for this lane, so the MONGO_URL-unset boot smoke is an assertion about a property, not an observation. Whoever copies it into the CRM repo must paste the real output back here.
2. **`fleet env-diff` has never hit Render.** The brief allowed exactly one real call and it was spent on `status`. A10 is proven against the inventory in `discovery/env-inventory.md` §3.1 as fixture data: 24 + 7 = **31** asymmetric keys. ⚠ The live number is probably **29** today — `COORDINATION.md` records `PUURE_DATABASE_URL` removed from mineblock-dashboard and `SHOPIFY_WEBHOOK_SECRET` set on puure-dashboard on 2026-09-10, and both were in the asymmetric set. Run `node scripts/fleet.mjs env-diff puure-dashboard mineblock-dashboard` when a real call is authorised and reconcile.
3. **`.github/workflows/ci.yml` has never run on a GitHub runner** — no push is allowed from a lane. Each step was exercised locally: the smoke suite, the lint gate, and the R15 guard. The Postgres service container's port mapping (5433:5432) and the gitleaks action are the two pieces that only a real run can confirm.
4. **`fleet deploy` and `fleet rollback` have never sent a real POST.** Both are covered by mocked-fetch tests including the polling loop and the rollback target selection, and both refuse loudly. First real use must be bracketed (R1/R3).

## What I found (this is the part worth reading)

1. **37 of 91 test scripts do not test this repository.** They import production source and `node_modules` from other clones by absolute path (`/Users/ludo/Mineblock-LLC/...`, `/Users/ludo/Puure-integrator/...`, `/Users/ludo/funnel-os/...`). 13 of them pass on this Mac today — proving something about a *different working copy*. They can never run in CI. All 37 are quarantined with the condition for their return. **Un-quarantining them is one line per file and it is the highest-value cleanup on this tree.**
2. **The suite needed scratch databases nobody creates.** 22 scripts share a `puure_shoporder` database and `split/statistics.mjs` needs `puure_split`; no script creates either, so on a clean machine they die with `database "..." does not exist`. The runner now provisions every role and database named by a DSN in the scripts it is about to run — local clusters only, and it refuses to touch anything that is not local.
3. **58 scripts hardcode `postgres://puure@127.0.0.1:5433/<db>`.** `PGURL` is exported to every child, but the scripts ignore it. CI works around this by mapping the service container to host port 5433. Making the scripts read `PGURL` is a follow-up slice.
4. **`server/migrations/run.js` does not implement `--help`.** The flag is ignored and the runner attempts a real migration. More importantly: **migrations cannot run on an empty database** — they stop at `017_create_spy_custom_images.sql` with `relation "product_profiles" does not exist`. That is an R6 violation and it is Lane A's slice. The smoke placeholder is written to pass both on today's known defect and on Lane A's fix, and to fail on anything else.
5. **There is no test anywhere for product profiles**, although `server/src/routes/productProfiles.js` exists and migration 017 depends on the table. The brief asked smoke to cover product-profile CRUD; it cannot.
6. **All four `orders/*` scripts are unrunnable** (three by absolute-path imports, one by a real failing assertion), so "orders list" has no smoke coverage either. Smoke substitutes the nearest real coverage and the gap is recorded.
7. **One genuine pre-existing red:** `orders/post-purchase-ui.mjs`, `FAIL U8 the dunning page is in the sidebar under orders:access` (32 passed, 1 failed) on a clean `edc1030`. It is a `client/` sidebar assertion, outside this lane's file ownership. It is quarantined; that quarantine entry is the only thing keeping `npm test` from arriving red.
8. **`ai-media/dialog-dom.mjs` leaves `client/.tmp-aimedia-dom/` behind** on every run — an untracked directory inside `client/`. Left in place (this lane may not touch `client/`); it should be cleaned up or gitignored.
9. **Render says `puure-crm` is still live on `1466078`** — the pill-colour leak commit from the 2026-09-10 incident, finished `2026-09-09T15:53:14Z`. The rollback recorded as "pending Ludo's typed authorisation" has not happened. Not this lane's call; flagging it because `fleet status` made it visible.

## Open questions for the lead

1. Do the 37 absolute-path test scripts get a repair slice, or do they stay quarantined until the hub splits the repos? They are 41% of the suite.
2. `docs/crm-ci.yml` needs an owner with commit rights on the CRM repo. Who copies it, and who pastes the observed boot-smoke output back?
3. The smoke suite has no orders-list and no product-profile coverage because neither exists in runnable form. Should writing those tests be a slice, or is the gap accepted for now?
4. CI installs with `npm ci --ignore-scripts` (skips the Playwright browser download). That is right for smoke, and wrong the day a browser test enters CI. Add a browser-install step then, or split the job?

## Next action for the next session

Merge this branch, then run the workflow once on a real push and paste the actual run output into the proof pack — that is the only unproven piece of goal 2.
