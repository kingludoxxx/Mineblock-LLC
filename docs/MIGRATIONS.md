# Migrations: the deploy contract (S0b-3)

Applies to every service that runs this codebase (mineblock-admin / mineblock-dashboard, puure-dashboard, mineblock-crm if it runs it). Source of truth for the runner is `server/migrations/run.js`; for the order, `server/migrations/order.json`.

## 1. Who applies migrations

| Moment | What happens | Writes the ledger? |
|---|---|---|
| `npm start` (boot) | READ-ONLY check of `_migrations` vs `order.json`. Logs `Migrations: ledger matches order.json (...)` or `MIGRATIONS NOT APPLIED: ...`. With `STRICT_MIGRATIONS=1` a pending or mismatched set refuses to boot (exit 1). | No |
| `npm run migrate` | Applies pending files in `order.json` order, one transaction per file, under an advisory lock. Backfills legacy (filename-only) rows once. | Yes, the ONLY writer |
| `npm run migrate:dry-run` | Report only. Exit 1 unless the database is current (see section 5). | No |
| Render `preDeployCommand: npm run migrate` | Render runs it from ITS checkout of the deployed commit, before the new instance starts. A failure (checksum mismatch, rename, SQL error, STRICT orphan) fails the deploy and the previous instance keeps serving. | Yes (it is `npm run migrate`) |

Boot no longer applies migrations. A commit that adds a migration and is deployed without a pre-deploy command is applied NOWHERE: the server logs one error line and serves. That is why the pre-deploy command is part of the contract, not an option.

## 2. First run per live database (one-time, per store)

The first `npm run migrate` on a live database backfills the checksum of every legacy row from the CURRENT bytes on disk: whichever checkout runs first blesses those bytes forever (review P1-3). So the first live run happens ONLY through Render's pre-deploy command on the merged commit, never from a laptop or a worktree. In order:

1. R38 first. Same-day `pg_dump` of the store database, restored locally, row counts checked. The first run writes `_migrations` (one UPDATE per legacy row plus one INSERT per new file) and runs the new files (120, 121, 122 are no-ops on the live shape); that is still "a migration run on a live store's database".
2. Rehearse on a copy of the restored dump, from a CLEAN checkout of the exact commit that will be deployed (R37 commitId):
   ```
   CREATE DATABASE rehearsal TEMPLATE <restored>;
   DATABASE_URL=<rehearsal> npm run migrate:dry-run -- --allow-pending   # expect: legacy (no checksum): N | pending: K | mismatches: 0, exit 0
   DATABASE_URL=<rehearsal> npm run migrate                              # expect: Backfilled ... N legacy ledger row(s); Successfully ran K migration(s)
   DATABASE_URL=<rehearsal> npm run migrate:dry-run                       # expect: pending: 0 | mismatches: 0, exit 0
   DATABASE_URL=<rehearsal> npm run migrate                              # expect: All migrations are up to date. (ledger byte-identical)
   ```
   Orphans (ledger rows whose file no longer exists, e.g. a puure `089_*`) are printed as warnings here; resolve them BEFORE step 5, because STRICT refuses them.
3. Make sure the pre-deploy command exists. `render.yaml` carries `preDeployCommand: npm run migrate` for `mineblock-admin`. For services not declared in that blueprint (puure-dashboard, mineblock-crm), set Settings -> Pre-Deploy Command to `npm run migrate` in the Render dashboard. Pre-deploy commands need a paid instance type; the services are on `starter`, so confirm on each service before relying on it.
4. Deploy with an explicit `commitId` (R37). In the deploy log expect `Backfilled checksum + applied_order for N legacy ledger row(s)` and `Successfully ran K migration(s)`; at boot expect `Migrations: ledger matches order.json (M applied, 0 pending, 0 mismatches)`.
5. Only then set `STRICT_MIGRATIONS=1` on the service (one restart). From that point a pending, mismatched, or (for `npm run migrate`) orphaned migration refuses instead of logging.

## 2b. STORE_CODE — required on every service (Lane C, review F1)

`npm run migrate` REFUSES to run without `STORE_CODE` (`^[A-Z0-9]{2,4}$`). It is not optional and it
has no default. The runner sets it as the transaction-local `app.store_code` for every migration, and
the store-tagging migrations (123/124) tag every row with it. A default would have labelled every
Puure row as Mineblock's store, silently and self-reinforcingly.

| Service | STORE_CODE |
|---|---|
| mineblock-admin / mineblock-dashboard | `MB` |
| puure-dashboard | `PL` |
| any new store | its code from the manifest, before the first deploy |

**Set it BEFORE the first `npm run migrate` on that service, or the pre-deploy command fails and the
deploy is refused (which is the intended behaviour, not a bug).** `render.yaml` does not yet carry it:
the lead adds `STORE_CODE` to `mineblock-admin`'s `envVars` and to every service's environment in the
Render dashboard as part of merging this branch. A dry run does not require it; it prints
`STORE_CODE: …REFUSING…` so a preflight tells you before the deploy does.

Each migration transaction also runs `SET LOCAL lock_timeout` (`MIGRATION_LOCK_TIMEOUT`, default `5s`,
`0` disables). 123 takes ACCESS EXCLUSIVE on 39 tables in one transaction; behind a long read it would
otherwise wait forever and queue every later reader behind it. On a timeout the transaction rolls back,
the ledger is untouched and the same command is simply re-run at a quieter moment.

## 3. STRICT

`STRICT_MIGRATIONS=1` (env) or `--strict` (flag) means:
- boot: pending or mismatched migrations refuse to start;
- `npm run migrate` / `migrate:dry-run`: orphan ledger rows (applied here, file gone from disk and `order.json`) refuse instead of warn. A deleted migration never runs on a fresh database, which is why STRICT treats it as an error.

Renamed applied files (a pending file whose sha256 equals an orphan row's checksum) are refused in every mode: that is a re-execution in disguise. Edited applied files (checksum mismatch) are refused in every mode.

## 4. Standing rules for migration authors

- File + `order.json` entry in the SAME commit. `run.js` refuses an unlisted, absent, duplicated, or non-`.sql` entry before touching the database.
- Append at the END of `order` unless the file must precede an existing dependent (then directly before it). The numeric prefix is documentation, not the order.
- Numbering: 100-119 tracking/Puure sessions, 120+ HUB. Lane A used 120, 121, 122; Lane C uses 123, 124
  (and reserves 125 for `staged/125_clickup_brief_resolutions_rekey.sql`, which is NOT auto-run — `run.js`
  and `server.js` read only `*.sql` directly under `server/migrations/`). The next free HUB number is 126.
- Never rename or edit an applied file. Fix forward with a new file. (Checksum mismatch and rename are both refusals.)
- Never delete an applied file. Under STRICT the orphan row refuses the run; without STRICT it is a printed warning and the file silently never runs on a fresh database.
- A migration must run on an EMPTY database (R6) and be a no-op where the route already created the shape. Guard with the catalog (`IF NOT EXISTS`, `information_schema`, `pg_constraint`), not with `EXCEPTION WHEN OTHERS`: a swallowed error is how 017/061 hid a missing table for months. `RAISE WARNING` when you decline to act; `run.js` prints database warnings in the deploy log.
- Never run `npm run migrate` against a live URL from a worktree or laptop. `run.js` refuses without `DATABASE_URL`; that is the only guard.
- `--mark-applied a.sql,b.sql` records files as applied WITHOUT running them (schemas that arrived by `pg_dump`). Validated against `order.json`; backfills legacy rows first so history order is preserved.

## 5. CLI and exit codes

```
node server/migrations/run.js [--dry-run [--allow-pending]] [--strict] [--dir <migrationsDir>] [--mark-applied a.sql,b.sql]
env: DATABASE_URL (required), STORE_CODE (required for a real run, ^[A-Z0-9]{2,4}$), MIGRATIONS_DIR (= --dir),
     STRICT_MIGRATIONS=1 (= --strict), MIGRATION_LOCK_TIMEOUT (default 5s), MIGRATE_SSL=0|1
npm run migrate            = node server/migrations/run.js
npm run migrate:dry-run    = node server/migrations/run.js --dry-run   (extra flags after --, e.g. -- --allow-pending)
```

| Situation | real run | `--dry-run` | `--dry-run --allow-pending` |
|---|---|---|---|
| current (0 pending, 0 mismatches, 0 orphans) | 0, "up to date" | 0 | 0 |
| pending files | applies them, 0 | 1 | 0 |
| checksum mismatch (edited applied file) | refuses, 1 | 1 | 1 |
| renamed applied file (pending file == orphan row's checksum) | refuses, 1 | 1 | 1 |
| orphan row, non-STRICT | warns, continues, 0 | warns, 0 | warns, 0 |
| orphan row, STRICT | refuses, 1 | 1 | 1 |
| manifest broken / DB unreachable / no DATABASE_URL | 1 before any write | 1 | 1 |
| STORE_CODE unset or malformed | refuses, 1, before any write | warns, 0 | warns, 0 |
| a migration cannot take its locks within `lock_timeout` | that file rolls back, run exits 1, ledger untouched | n/a | n/a |

Ledger: `_migrations(id, filename UNIQUE, executed_at, checksum sha256-hex-of-bytes, applied_order)`. `applied_order` is the per-database apply sequence (1-based, monotonic), not the manifest index; re-ordering the manifest never invalidates history.

Tests: `node server/tests/migrations/migrations.mjs` (A1-A8; A7/A8 need the read-only `mineblock_copy` on the local Postgres, they SKIP otherwise)
and `node --test server/tests/store-code/*.test.mjs` (Lane C A1-A7: tagging, backfill, the STORE_CODE refusal and the lock timeout).
