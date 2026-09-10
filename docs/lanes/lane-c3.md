# Lane handoff — C3 (store identity in the migration ledger, the Puure gate)   last session 2026-09-10   commit <this branch's HEAD>

Worktree `/Users/ludo/wt-c3-identity`, branch `day2/c3-identity`, off `hub/main` `64a40d8`. Nothing pushed,
nothing deployed, no Render / Shopify / Whop / Atlas / R2 call. Local Postgres only.

## Where I stopped
Done and self-contained. `server/migrations/127_store_identity.sql` + `order.json` entry (111 entries,
127 last), `server/migrations/run.js` identity gate (`readStoreIdentity` / `assertIdentityMatches` at
`run.js` — first statement inside `withLock`, before `ensureLedger`), the `--relabel-identity
--i-typed-the-store-name=<Name>` override, and the post-run column-default report
(`reportStoreCodeDefaults`). Tests `server/tests/store-code/c3-store-identity.test.mjs` (13).
Docs `docs/MIGRATIONS.md` §2 (first-run note), §2b (pointer), new §2c + §2d, §4 numbering, §5 tables.

## What is proven (proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-C3.md`)
- RED, on `hub/main`: `STORE_CODE=MB migrate` then `STORE_CODE=PL migrate` on a copy of `mineblock_copy`
  → exit 0, no complaint, 90 columns still `'MB'::text`. GREEN, identical sequence: exit 1,
  `STORE IDENTITY MISMATCH: database is MB, STORE_CODE is PL`, ledger 111 rows unchanged, 0 columns changed.
- Empty database (no template): 111 migrations, identity recorded `SB`, second run reports it, `PL` refused.
- Override: wrong/absent typed name, no configured display name, and `--dry-run` all refused with no write;
  correct name relabels and prints old -> new.
- Column-default report: clean MB copy `MB: 90, other stores: 0` exit 0; one crafted `'PL'` default →
  `other stores: 1`, exit 1, names `puure_leftovers.store_code`.
- Edges: table absent → "no identity yet"; malformed row (`mb`, `mineblock`, `''`, `'   '`, `TOOLONGCODE`)
  and a two-row table → refused, real run AND dry run.
- Suites at HEAD: migrations 76/76, store-code 27/27 (14 existing + 13 new).

## What is NOT proven
- Nothing ran against a live database or a live service (by rule). Puure's and Mineblock's real ledgers
  are untouched and unread.
- `RENDER_GIT_COMMIT` is exercised as an env var, not observed coming from Render.
- No browser / UI surface is involved in this slice.

## Open questions for the lead
1. `STORE_NAME` does not exist anywhere in the codebase today; `BRAND_NAME` does (`env.PL.example:12`
   `BRAND_NAME=Puure`). The runner accepts `STORE_NAME` first and falls back to `BRAND_NAME`. If the hub
   later introduces a real `STORE_NAME`, nothing changes; if it never does, `BRAND_NAME` is the typed name.
   Confirm that `BRAND_NAME` is set on `mineblock-dashboard` too, or a relabel there is impossible
   (which is the safe direction, but it should be a choice).
2. The relabel deliberately leaves the run failing on the column-default report until
   `backfill-store-codes.mjs --relabel-store <CODE>` has run. Confirm that two-step order is what the
   bracket wants.

## For the merge / the Puure bracket
On the next Mineblock deploy 127 runs and records `MB` (from `STORE_CODE=MB`, already required since
Lane C's F1). On Puure's first run it records `PL`. From then on a wrong `STORE_CODE` on Puure is
refused before any write, and the manual "column_default must be exactly `'PL'::text`" step of the
bracket is now the runner's own post-run report (exit 1 if it is not).

## Next action for the next session
Nothing here. If S1-2 starts reading `store_code`, extend `ensureTable` call sites so newly created
`co_*`/`lb_*` tables get the column (REVIEW-MERGE-1 P2-2) — unrelated to this slice.
