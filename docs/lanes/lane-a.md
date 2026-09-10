# Lane handoff — Lane A · S0b-3 Migration reset   last session 2026-09-10   commit b41957f (code + tests; this note lands in the next commit)

Branch `day1/lane-migrations`, worktree `/Users/ludo/wt-lane-migrations`, base `edc1030`.
Proof pack: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-A.md` (verbatim outputs).

## Where I stopped (exact step, file:line)
All acceptance lines A1–A6 implemented and green (55 PASS, 0 FAIL). A7 is SKIPPED on its precondition: `mineblock_copy` does not exist on 127.0.0.1:5433 (`server/tests/migrations/migrations.mjs:319`, the `if (await dbExists('mineblock_copy'))` branch). The lead's `~/backups/db/pg-mineblock-20260910T104237Z.dump` was still being written by `pg_dump` when I stopped (file open for write, growing); `pg_restore -l` succeeds on a partial custom-format file, so completeness must be checked by the process having exited, not by the TOC.

## What is proven (proof pack) and what is not
Proven by execution:
- Empty DB → 106/106 applied in manifest order, twice idempotent (A1). Before: old order failed at 017 (`product_profiles`), then at 061 (`creative_analysis.meta_ad_id`), both route-only shapes; now `120_create_product_profiles.sql` and `121_creative_analysis_route_columns.sql` sit between 016 and 017 in `order.json`.
- `_migrations.checksum` (sha256 of bytes) + `applied_order`; edited applied file refused by name, ledger untouched; `--dry-run` never writes (A2, A6.8).
- Legacy ledger (104 filename-only rows over a route-created schema) → backfilled ONCE, run continues with 120/121, `executed_at` untouched, second run byte-identical (A3).
- `server.js` boot: no writer; `STRICT_MIGRATIONS=1` + pending → exit 1 with the file list; unset → error logged, server still starts; migrated DB → "ledger matches order.json (106 applied, 0 pending, 0 mismatches)".
- `/admin-init-puure-schema`: 403 without secret; 200 read-only report; no `_migrations` table created on the target.
- Two simultaneous runners: advisory lock → one applied 106, the other found "up to date"; 0 duplicates.
- `068`: `EXCEPTION WHEN OTHERS` gone; failure visible (`42P01`) without the table; idempotent with it (A5).
- All A6 failure paths exit non-zero naming the culprit, no writes.

NOT proven:
- A7 (real live-copy dry-run). The A3 simulation pre-creates `product_profiles` and the creative_analysis route columns by regex-extracting them from `productProfiles.js` / `creativeAnalysis.js`; the real live ledger may additionally hold orphan rows (files no longer on disk, e.g. an `089_*`) — those are WARNINGs, not errors. Only the real copy settles it.
- A4 is PARTIAL: `/admin-reconcile-migrations` (`server/src/routes/staticsGeneration.js` ~1239-1300) is a second, deliberate ledger writer (`INSERT INTO _migrations (filename) … ON CONFLICT DO NOTHING`, line ~1278). The brief's ownership list allowed ONLY the block around 1472, so I left it untouched. `run.js` now exports `markApplied(client, filenames, { dryRun })` with identical validation semantics, so the swap is: replace lines ~1265-1283 with one call and delete the local INSERT. After that, `grep -rn "_migrations" server/src server/migrations` shows writes only in `run.js`. (Test A4.3/A4.4 assert the current honest state with an explicit allowlist and a comment.)

## Open questions for the lead (not for Ludo)
1. `/admin-reconcile-migrations`: swap to `markApplied()` (one writer, literally) or delete the endpoint? Both are ~5 lines; I need the ownership go-ahead.
2. **Deploy contract change.** Boot no longer applies migrations and `render.yaml` has no `preDeployCommand`. Before this merges to `main`, add `preDeployCommand: npm run migrate` (or run it by hand inside the R38 bracket), otherwise the dashboards stop picking up new migrations. Today `STRICT_MIGRATIONS` is unset on the live services, so they would boot and log `MIGRATIONS NOT APPLIED`, not fail. Announced in COORDINATION.md "Shared-file changes".
3. **Credential exposure (rotation candidate).** The dump job runs `pg_dump` with the mineblock DB password inside the URL in its argv; it is visible to any `ps`, and it surfaced verbatim in this lane's transcript through a `pgrep -fl` I ran to see whether the dump had finished. I copied it nowhere. Transcripts are append-only, so redaction is not rotation — your call.
4. Checksum semantics for historically edited files: `068` (edited by this lane) and `071` (edited in place per 072's comment) get their checksum backfilled from the CURRENT bytes on live (by design: legacy rows have no prior truth). From then on any edit is refused.
5. `120` keeps `category TEXT DEFAULT 'supplement'` because it mirrors the route DDL byte-for-byte in shape; it is a category default, not a store name. Flag if you want it dropped from the migration.
6. `.env`/dotenv: `run.js` loads the repo-root `.env` only when invoked as a CLI (not when imported by `server.js`).

## Next action for the next session (one line)
When `pgrep -f "pg_dump.*pg-mineblock"` returns nothing: `createdb -h 127.0.0.1 -p 5433 -U postgres mineblock_copy && pg_restore --no-owner --no-acl -j 4 -h 127.0.0.1 -p 5433 -U postgres -d mineblock_copy ~/backups/db/pg-mineblock-20260910T104237Z.dump` (lead/integrator: it is the shared read-only reference DB), then `node server/tests/migrations/migrations.mjs` runs A7 (creates `lane_migrations_mbcopy TEMPLATE mineblock_copy`, `run.js`, `--dry-run` → expect 0 pending, 0 mismatches) and the pack gets its §A7 block.

## order.json semantics (what Lane C needs to list its migrations)
- `server/migrations/order.json` → `{ "_doc": "...", "order": [ "001_create_roles.sql", … ] }`. `run.js` applies files in EXACTLY this array order; the numeric prefix is documentation only.
- Every `.sql` in `server/migrations/` must appear exactly once. Unlisted file, listed-but-absent, duplicate, non-`.sql`, or missing/invalid manifest → exit 1 naming it, before any DB connection.
- To add a migration: create `NNN_name.sql` (100–119 tracking/Puure sessions, 120+ HUB; next free HUB number is **122**) and append the filename at the END of `order`, unless it must precede an existing dependent (insert directly before it).
- Ledger: `_migrations(id, filename UNIQUE, executed_at, checksum sha256-hex-of-bytes, applied_order)`; `applied_order` is the per-database apply sequence (monotonic), not the manifest index, so re-ordering the manifest never invalidates history. Legacy rows are backfilled once. Applied files are immutable: fix forward with a new file.
- On an existing database, pending files run in manifest order relative to each other, after everything already applied.
- CLI: `npm run migrate` · `npm run migrate:dry-run` (no writes; exit 1 on mismatch) · `--dir <path>` / `MIGRATIONS_DIR` · `--mark-applied a.sql,b.sql` · `MIGRATE_SSL=0|1` (default: off for localhost/127.0.0.1/`sslmode=disable`, on otherwise). Exported for read-only use: `checkPending(client, { dir })` → `{ applied, pending, mismatches, legacy, orphans, clean }`.
