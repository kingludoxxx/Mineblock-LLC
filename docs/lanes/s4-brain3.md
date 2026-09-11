# Lane S4-SB3 — closing the Store Brain's SECOND-pass review

Worktree `/Users/ludo/wt-s4-brain3`, branch `day2/s4-brain3`, from `3c7957c`.
Input: `briefs/out/REVIEW-S4-SB2.md` (verdict BLOCK: 1 P0, 1 P1, 8 P2).
Proof: `briefs/out/PROOF-S4-SB3.md` — every finding red-before-green, verbatim.

Nothing was pushed, deployed, or pointed at a live service or a remote database.
Local Postgres only, my own databases, all prefixed `sb3_` (R43) and dropped at the
end: `sb3_httpprobe`, `sb3_lockrace`, `sb3_mbclone`, `sb3_empty`, `sb3_brain_*`
(5433) and `sb3_vecprobe`, `sb3_s4_brain_vector` (5434). `mineblock_copy` was only
ever a `TEMPLATE` source, never opened for writing.

## What changed, and where the rule now lives

| finding | where the fix lives | in one line |
|---|---|---|
| **NEW-1** P0 | **new** `server/src/services/brain/brainScope.js` + `middleware/brainAuth.js` + `brainStore.listInsights` | the "who may see unapproved work" rule is one module, it is **mandatory**, and a read door that forgets it raises `scope_required` instead of leaking |
| **NEW-2** P1 | `brainStore.putPlaybook` / `lockPlaybook` / `unlockPlaybook` | the head row is read inside the transaction, `FOR UPDATE` |
| **NEW-3** P2 | `brainStore.getPlaybook` | `cites` = approved right now; `stale_cites` = the rest, with the status that disqualified each |
| **NEW-4** P2 | `brainStore.BACKFILL_MAX_PER_REQUEST` (10) + `brainSearch` | bounded per request and REPORTED in the response. Metering itself stays queued |
| **NEW-5** P2 | `brainSearch.parseFilters` / `search` | `provider` moves to the ctx argument; the query key is refused 400 |
| **NEW-6** P2 | `middleware/brainAuth.serviceTokenProblem` | whitespace-wrapped token → 503 naming `BRAIN_SERVICE_TOKEN` |
| **NEW-7** P2 | `services/brain/brainBucket.prefixCode` | `STORE_CODE` checked against `^[A-Z0-9]{2,4}$` where the prefix is built |
| **NEW-8** P2 | `migrations/131_brain_permissions.sql` | the `UPDATE` is scoped to 128's exact `["access"]` shape |
| **NEW-9 / P2-10** P2 | `brainSchema.assertNoNul`, `brainSearch.boundary` | NUL and unparseable dates are 400, never 500 |
| **P2-8** P2 | `brainStore.setInsightStatus` | every transition appends to `metadata.review_history`, keeping the old rejection reason. No new migration |

Two decisions worth knowing before you touch this again:

* **`search()`'s signature changed.** `search(sql, opts, ctx)` where `ctx` carries
  `{mayReadUnapproved, provider}`. `opts` is the request; a `provider` key in it is a
  400. Every caller in the repo was updated; the pinned pre-fix tree therefore cannot
  run the new `brain-vector.mjs` at all, which is why NEW-4/NEW-5's red is recorded
  by `probes/sb3-vector-probe.mjs` (HTTP, signature-independent) rather than by the
  suite.
* **`req.brainScope` is built in `brainAuth`, once.** Do not re-derive it in a route.
  A new read door passes `req.brainScope` to the store function or it raises on its
  first request — that is deliberate and B11.7 asserts it.

## Where the next session picks up

1. **P2-9 + NEW-4's metering half are one task, not two** (docs/BRAIN.md § Open
   items). `/extract` on the worker and per-store spend metering need the same
   counter; doing either alone builds half of it twice. R17 + R18.
2. **P2-12 is the integrator's, and it is a gate.** Whether Render Postgres 16 ships
   pgvector decides which search path production runs and is still asserted, never
   measured. No lane may probe a live service. It needs confirming in writing on the
   SB database before the train.
3. **One watched R2 round trip** the first time a store sets `R2_*`. Everything about
   the bucket is proved against the derived key and `bucketTarget()`'s refusals;
   nothing has been uploaded.
4. **Migration 131 against a Puure-shaped role table is unmeasured** — no verified
   Puure dump locally and R38 forbids inventing one. The new guard bounds it to roles
   whose brain permission is exactly `["access"]`, but the run has not happened.
5. `BRAIN_TEST_DB_PREFIX` now exists on all four Brain suites. Use it (R43).
