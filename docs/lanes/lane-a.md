# Lane handoff — Lane A · S0b-3 Migration reset   last session 2026-09-10 (Lane A2, review fixes)   commit 2db19fe (+ this note)

Branch `day1/lane-migrations`, worktree `/Users/ludo/wt-lane-migrations`, base `edc1030`. First session: `b41957f` + `3caf382`. Second session (A2, fixes from `briefs/out/REVIEW-LANE-A.md`): `5704fde`, `8c9d1d9`, `00ad796`, `0a4d19b`, `f4e9f39`, `2db19fe`.
Proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-A.md` (first session + "A2 section" appended, all outputs verbatim).
Deploy contract: `docs/MIGRATIONS.md` (in this repo).

## Where I stopped (exact step, file:line)
All review items delivered and green: `node server/tests/migrations/migrations.mjs` → `76 passed, 0 failed, 0 skipped` at `2db19fe` (A7 and A8 execute against `mineblock_copy`). The A7 rehearsal was also run by hand on a fresh `TEMPLATE mineblock_copy` with the exact commands of `docs/MIGRATIONS.md` §2 (pack §5). Tree clean. Nothing pushed, nothing deployed, no live call.

## What is proven (proof pack) and what is not
Proven by execution (A2 section):
- P1-1: a renamed applied file (pending file whose sha256 equals an orphan row's checksum) is refused by name, real run and dry run, ledger untouched (A2.7–A2.9; red run showed the re-execution). `--strict` / `STRICT_MIGRATIONS=1`: orphan rows refuse; without it they are a visible `WARNING: orphan ledger row …` line (A6.9–A6.11).
- P1-2: after a fresh migrate, `creative_analysis` equals `mineblock_copy` on (column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default), 43 = 43 (A8.1; md5 `598824978ec9…` identical across fresh, rehearsal copy and `mineblock_copy`); the route's own INSERT (23 columns, extracted from `creativeAnalysis.js`, 25-char creative_id) succeeds with an integer `RETURNING id` (A8.3); the route's `UNIQUE (creative_id, hook_id, week)` exists (A8.2); 122 issues no ALTER on the live shape (A8.4) and is idempotent (A8.5); a non-empty 016-shaped table keeps its row, gets the additive columns, and the run prints the migration's WARNING (A8.6–A8.7).
- P2-2: `--dry-run` exits 1 on pending files, `--dry-run --allow-pending` exits 0, neither writes, `--allow-pending` alone is refused (A6.12–A6.15).
- P2-1: `--mark-applied` on a legacy ledger backfills first: legacy rows keep 1..N, marked file N+1, all checksummed (A3.12).
- A7 by hand on a fresh TEMPLATE copy: dry-run exit 1 (3 pending) → `--allow-pending` exit 0 → migrate: `Backfilled … 104 legacy ledger row(s)`, ran 120/121/122, exit 0 → dry-run and STRICT dry-run exit 0 → ledger 107 rows, 0 NULL, applied_order 1..107, legacy `executed_at` untouched → second run "up to date", ledger md5 identical → `mineblock_copy` still legacy (104 rows).
NOT proven:
- The Render side: `preDeployCommand` takes effect only on a paid instance type; the services are `starter`. Not verifiable from a lane (COMMON forbids Render calls). Verify per service before relying on step 3 of `docs/MIGRATIONS.md` §2.
- Puure's database was not available: its `creative_analysis` shape and any orphan rows (`089_*`) are unknown. 122 handles a 016-shaped table with rows by WARNING + skip (decision 1 below).
- A4 is still PARTIAL by design: `/admin-reconcile-migrations` keeps its filename-only INSERT (one-line pointer comment added at `staticsGeneration.js` above the route; the lead owns the swap/delete).

## Open questions for the lead (not for Ludo)
1. `/admin-reconcile-migrations`: swap to `markApplied()` or delete (unchanged from session 1; comment added).
2. Orphans before STRICT: if puure carries an orphan row (e.g. `089_*`), `npm run migrate --strict` will fail its deploy. There is deliberately no `--forget-orphan`; options are (a) restore the file to disk + `order.json` under its original name, or (b) a one-off manual ledger DELETE inside an R38 bracket. Your call.
3. DECISION MADE, flip if you disagree: 122 section B (id uuid→integer, purchases→integer, NUMERIC(p,2), hook_id NOT NULL) only runs on an EMPTY table; a table with rows still in the 016 shape gets `RAISE WARNING` (printed by run.js) and keeps its data; the route works there after section A. One line to make it a refusal instead.
4. Known gap: the rename guard needs the orphan row's checksum; a LEGACY orphan (checksum NULL, i.e. renamed before that database's first `npm run migrate`) is only caught by STRICT. Under the contract the first live run is Render's on the merged commit, and the rehearsal prints `orphans: N` for a human to read.
5. `server.js` boot: `report.clean` still ignores orphans (STRICT boot refusing on a puure orphan would be unrecoverable without a ledger tool). Orphans refuse at the pre-deploy step instead. Say if you want boot to refuse too.
6. The review's other live-only columns (`brief_pipeline_winners.{generation_error,generation_model,reference_id,updated_at}`, `brief_pipeline_references.source_url`, `launch_templates.{landing_page_url,schedule_date,schedule_enabled,schedule_time}`) are route-added, never migrated, and outside this ask. Same class as P1-2; a 123+ file by whoever owns those routes.
7. Lane C's `121`/`122` files in its worktree collide with this lane's numbers; the lead renumbers them to 123+ at merge (per the A2 brief). Next free HUB number after this lane: **123**. Note `docs/MIGRATIONS.md` §4 says so.
8. `render.yaml`: `preDeployCommand: npm run migrate` added under `mineblock-admin` (announced in COORDINATION.md "Shared-file changes" first). puure-dashboard and mineblock-crm are not in the blueprint: dashboard setting.

## Next action for the next session (one line)
Lead: merge `day1/lane-migrations` (6 new commits) to the landing worktree, renumber Lane C's files to 123+, then per store follow `docs/MIGRATIONS.md` §2 steps 1–5 (dump, rehearsal from a clean checkout of the deployed commit with `npm run migrate:dry-run -- --allow-pending` → `npm run migrate` → `npm run migrate:dry-run`, pre-deploy command, commitId deploy, then `STRICT_MIGRATIONS=1`).

## order.json semantics (what Lane C needs to list its migrations)
- `server/migrations/order.json` → `{ "_doc": "...", "order": [ "001_create_roles.sql", …, "122_creative_analysis_fresh_shape.sql" ] }`, **107 entries**. `run.js` applies files in EXACTLY this array order; the numeric prefix is documentation only. `120` and `121` sit between `016` and `017`; `122` is last.
- Every `.sql` in `server/migrations/` must appear exactly once. Unlisted file, listed-but-absent, duplicate, non-`.sql`, or missing/invalid manifest → exit 1 naming it, before any DB connection.
- To add a migration: create `NNN_name.sql` (100–119 tracking/Puure sessions, 120+ HUB; next free HUB number is **123**) and append the filename at the END of `order`, unless it must precede an existing dependent (insert directly before it). File + manifest entry in the same commit.
- Ledger: `_migrations(id, filename UNIQUE, executed_at, checksum sha256-hex-of-bytes, applied_order)`; `applied_order` is the per-database apply sequence, not the manifest index. Legacy rows are backfilled once (also by `--mark-applied`). Applied files are immutable: an edit is a checksum refusal, a rename is a rename refusal, a deletion is an orphan (warning; refusal under STRICT). Fix forward with a new file.
- A migration must run on an EMPTY database (R6) and be a no-op where a route already created the shape: guard with the catalog, never `EXCEPTION WHEN OTHERS`; `RAISE WARNING` when declining, `run.js` prints it.
- CLI: `npm run migrate` · `npm run migrate:dry-run` (exit 1 unless current; `-- --allow-pending` for the pre-apply rehearsal) · `--strict` / `STRICT_MIGRATIONS=1` · `--dir <path>` / `MIGRATIONS_DIR` · `--mark-applied a.sql,b.sql` · `MIGRATE_SSL=0|1`. Exported read-only: `checkPending(client, { dir })` → `{ applied, pending, mismatches, legacy, orphans, renames, clean }`. Full table: `docs/MIGRATIONS.md` §5.
