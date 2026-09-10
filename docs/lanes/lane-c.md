# Lane handoff — Lane C (S1-1 store-code tagging + per-product-code counters)   last session 2026-09-10 (C2, review fixes)   commit <see git log day1/lane-store-code>

Worktree `/Users/ludo/wt-lane-store-code`, branch `day1/lane-store-code`, rebased onto `hub/main` `95fc741`
(Lane A's S0b-3 runner + `order.json` + 120/121/122).
Proof packs: `~/tasks/multistore-hub/briefs/out/PROOF-LANE-C.md` (first pass) and
`PROOF-LANE-C2.md` (this pass: every REVIEW-LANE-C finding, red then green).

## C2 — what changed since the review (REVIEW-LANE-C.md)
| Finding | Fix | Where |
|---|---|---|
| F1 P1 no runner sets `app.store_code` | `run.js` `resolveStoreCode()` — `^[A-Z0-9]{2,4}$`, **REFUSES** when unset/malformed, before any write; `set_config('app.store_code', $1, true)` per migration transaction. 123/124 also RAISE when the setting is absent: no store literal is left as a fallback anywhere. | `server/migrations/run.js`, `123`, `124` |
| F2 P1 IM-counter unique index aborts the backfill | `ux_product_im_counters_product_code` dropped; key is `(product_code, product_id)` — unviolatable, since `product_id` is the PK and one code legitimately covers several products (069:6). Shared codes are reported. | `123` |
| F3 P1 backfill silently relabelled every row | step 0 FILLS `store_code IS NULL` only; a disagreeing `STORE_CODE` REFUSES and names the row count; `--relabel-store <CODE>` is the loud, opt-in repair. `STORE_CODE` is required (no `default_store_code`). | `backfill-store-codes.mjs`, `.rules.json` |
| F4 P1 number collision with Lane A | `121→123`, `122→124`, `staged/123→staged/125`; both files appended at the END of the real `order.json`; `laneMigrationFiles()` reads `order.lane-c.json` instead of a numeric regex. | `order.json`, `order.lane-c.json`, `_db.mjs` |
| F5 P2 ad-name evidence guesses on a shared number space | 5c now requires a second witness: no OTHER code may hold that brief number in `brief_pipeline_generated`. Otherwise the row stays untagged and is listed as a CONFLICT. | `backfill-store-codes.mjs` |
| F6 P2 foreign codes indistinguishable from native | `rules.store_products` (`MB: [MR]`, `PL: [PL, PUURE, P1]`) + a FOREIGN report section; the positional counter-id map and the P1 seed only apply on a store that owns the code. | `.rules.json`, `backfill-store-codes.mjs` |
| F7 P2 39 ACCESS EXCLUSIVE locks, no timeout | `SET LOCAL lock_timeout` per migration transaction (`MIGRATION_LOCK_TIMEOUT`, default `5s`, `0` disables). | `run.js` |
| F8 P3 duplicate `product_profiles` DDL | removed: Lane A's `120` precedes in `order.json` and owns it; the fixture applies the REAL `120`. | `123`, `_fixture-empty.mjs` |
| F9 P3 test coupling | expected store code read from `_db.mjs` `TEST_STORE_CODE` (env-driven); A2/A3 copies into `lane_store_code_a2a3_copy`, never the lane's `lane_store_code_mb`. | `_db.mjs`, `a1`, `a2-a3` |

🔴 **REQUIRED OF THE LEAD BEFORE ANY DEPLOY OF THIS BRANCH:** `npm run migrate` now REFUSES without
`STORE_CODE`, so the pre-deploy command fails on any service that lacks it. Set `STORE_CODE=MB` on
mineblock-admin / mineblock-dashboard and `STORE_CODE=PL` on puure-dashboard **first**, and add
`STORE_CODE` to `render.yaml`'s `mineblock-admin` envVars. This lane deliberately did NOT edit
`render.yaml` (shared blueprint, CLAUDE.md §5 says coordinate). Contract: `docs/MIGRATIONS.md` §2b.

## Where I stopped (exact step, file:line)
C2 complete: all nine review findings fixed, each with its failure reproduced first
(`briefs/out/lane-c2/red-*.txt`) and the identical check re-run green (`green-*.txt`).
Test totals: Lane C `14/14`, Lane A migrations `76/76`.
Slice delivered end to end on the local Postgres: tests (`server/tests/store-code/*.test.mjs`),
migrations `123_store_code_tagging.sql` + `124_store_code_lazy_tables.sql`, staged
`staged/125_clickup_brief_resolutions_rekey.sql`, `order.lane-c.json`, backfill
`server/scripts/backfill-store-codes.mjs` (+ `.rules.json`). A2/A3 were run on
`lane_store_code_mb` (CREATE DATABASE ... TEMPLATE mineblock_copy); numbers in the proof pack.
Nothing deployed, nothing pushed, no live service called.

## What is proven (proof pack) and what is not
Proven (actual output in the proof pack):
- A1 123+124 apply on an empty DB after the post-099 fixture, twice (idempotent); default follows
  `app.store_code`; an invalid code is refused and rolled back.
- A4 after 123 alone the legacy `ON CONFLICT (brief_number)` write still works and same-number
  coexistence is blocked (PK kept on purpose); after staged/125 P1 and PL share a number, duplicates
  are rejected, the keyed upsert works, and the legacy insert form fails with SQLSTATE 42P10.
- A5 unknown product code => row left untagged and listed; P1 recognised by the documented
  discriminators; dry-run writes nothing; second apply changes 0 rows.
- A6 no file under `server/src/`, `client/` or an already-applied migration changed. `run.js` IS changed
  in C2 (the F1/F7 runner contract) and A6 asserts exactly what changed in it.
- A7 (new) the F3 refusal + `--relabel-store`, and the F5 shared-number-space guard.
- A2/A3 dry-run report on the copy + idempotent apply (see proof pack §A2/A3).
Not proven / not in this slice:
- Nothing ran against a Render database (R38: same-day verified dump first; lead's call).
- The real 001-099 chain does NOT apply on an empty DB (dies at `061_creative_analysis_ownership.sql`:
  `column "meta_ad_id" does not exist`, because `creative_analysis.meta_ad_id` is added lazily by the
  app). Pre-existing; out of scope; the A1 fixture works around it. Task for the lead.
- No read/write path changed; the tags are inert until the increment sites below move to product_code.

## How the pieces fit
- `store_code` default = session setting `app.store_code` (validated `^[A-Z0-9]{1,8}$`), unset => `MB`.
  **Lane A's runner must `SELECT set_config('app.store_code', $STORE_CODE, true)` inside each migration
  transaction** (listed in `order.lane-c.json.runner_requirement`). The backfill also aligns the column
  default and every row to env `STORE_CODE` (unset => MB), so a store whose migration ran before the
  runner passes the setting is repaired by the backfill.
- `product_code` is filled only from evidence (product_profiles via product_id, parent row, naming
  prefix `P1 - B####`, ClickUp task id/url match, `/tmp-img/<id>` references). Never from the brief
  NUMBER. Anything else stays NULL and is printed under UNTAGGED; a disagreeing existing tag is printed
  under CONFLICTS and left alone.
- Lazily-created tables the brief names (`product_profiles`, `crm_orders`, `shopify_orders_cache`,
  `video_ads`, `video_ad_launches`, `image_store`, `clickup_brief_resolutions`, `statics_im_counter`,
  `brief_pipeline_analysis_cache`) are created by 123 with DDL copied verbatim from their route, so the
  column exists before the route's `CREATE TABLE IF NOT EXISTS` runs.
- 124 tags the remaining §1b lazy tables that exist and prints a NOTICE for each absent one.

## Increment sites that MUST change later (no code touched in this slice)
Counters are keyed by product code now; the code still keys them by integer id / product_id:
1. `server/src/routes/briefPipeline.js:1838-1840` `getNextBriefNumber`: DB max is bucketed by
   `product_code IN ('PUURE','PL')` vs everything else. Must become `WHERE product_code = $code`.
2. `server/src/routes/briefPipeline.js:1854-1866` `allocateBriefNumber(floor, counterId)`: seeds/updates
   `brief_number_counter` by `id` (1 = MR bucket, 2 = PL bucket). Must select/insert the row
   `WHERE product_code = $code` (unique index `ux_brief_number_counter_product_code` exists).
3. `server/src/routes/briefPipeline.js:4390` `briefCounterId = (PUURE||PL) ? 2 : 1` and `:4702` the call.
   Replace the id with the product code; P1 gets its own row (seeded by the backfill, id 3 on the copy).
4. `server/src/routes/adsReporting.js:62` DDL (add `product_code`), `:635` read
   (`WHERE brief_number = ANY($1)` must add the product code), `:714` upsert must become
   `ON CONFLICT (product_code, brief_number)` — and ONLY THEN move `staged/125` into `server/migrations/`
   in the same release (otherwise the write fails with 42P10; the write is fire-and-forget so the page
   survives but the cache silently stops filling).
5. `server/src/routes/staticsGeneration.js:3885-3896` `assignNextImNumber` (`UPDATE statics_im_counter ...
   WHERE id = 1`) and `:4891-4903` bootstrap: legacy global IM counter, `CHECK (id = 1)` still limits it to
   one row. Either retire it (product_im_counters supersedes it, per 099) or key it by product_code and
   drop the CHECK in a contract migration.
6. `server/src/services/staticNaming.js:55-66` `claimImNumber(productId)` and `:80-95` `syncCounter`:
   `product_im_counters` upserts by `product_id`. Must write `product_code` too (or key by it); today the
   backfill copies it from `product_profiles`.
7. `server/migrations/099_static_ad_naming.sql:40` defines `product_im_counters(product_id PK)`; the
   contract step later makes `(product_code)` the key.
8. Write-back of the tag: `server/src/routes/clickupWebhook.js:98-103` `taskIsP1()` is the only place that
   knows a card is P1; the brief generation insert (`briefPipeline.js` ~4700-4780) should write
   `product_code='P1'` for P1 cards so future rows do not need the backfill.
9. Every `ensureTable`/`createTables` of the §1b lazy tables that 124 skipped on an empty DB should add
   `store_code TEXT NOT NULL DEFAULT <store>` (or 124 is re-run as a sweep after first boot): orders.js:98/141/161/175,
   customers.js:28, abandonedCheckouts.js:108, abandonedRecovery.js:383, adRejectionMonitor.js:29/43,
   metaWebhook.js:25/35, adsControlCenter.js:74/101, adsReporting.js:39, creativeAnalysis.js:2731,
   funnelTrackingExtras.js:142, funnels.js:60/92/124, kpiSystem.js:564-715, checkoutSchema.js:31-250,
   dunningService.js:217/260, orderEditService.js:163-226, funnelCostsSchema.js:54-316,
   healthAlerts.js:159/184, integrationsSchema.js:36/44, optinLeads.js:26, pageVersionsSchema.js:61,
   splitTestSchema.js:58-245, trackingIntegrationsSchema.js:53-118, trackingSchema.js:36-245.

## What the copy of mineblock_copy showed (details + numbers in the proof pack §A2/A3)
- P1 footprint in Mineblock's Postgres: zero rows by every discriminator; P1 counter seeded at 0.
- `product_profiles` has one row (id 3, `Miner Forge Pro`, short_name `MR`, **product_code NULL**) so the
  product_id cascade tags nothing (678 spy_creatives, 200 statics_launches, 21 statics_queue, 91 events stay
  untagged). One-row data decision for the lead (`product_code := 'MR'`), then re-run the backfill: what-if shows
  851 rows would follow. The script will not guess it.
- `clickup_brief_resolutions`: 280 of 287 attributed to `MR` from canonical ad names in `creative_analysis`
  (step 5c, added after seeing `task_id` is NULL on every row); 7 remain untagged (`NA` placeholder only).
- `brief_pipeline_winners` carries 114 `PUURE` rows (pre-fork Puure residue, 2026-07-14..08-07). Reported only.
- `image_store` 794 rows are referenced by no creative (all 147 referenced ids are absent); untagged.

## Independent re-verification (second Lane C session, same day, at bdec6fb)
- Two Lane C sessions ran concurrently in this worktree; the second re-created `lane_store_code_mb` from the
  template and re-ran A2/A3 + the full suite (9/9, 0 skipped). Numbers matched `bdec6fb` exactly
  (dry=283, apply#1=283, apply#2=0; per-table counts and untagged samples identical). Stamp + verbatim suite
  output in the proof pack, last section.
- P1 on the Mineblock copy: 0 rows by every rule (profile short_name/name, `P1 - B####` naming, ClickUp task
  id/url, P1 product id in URL, `/tmp-img` refs). Only the seeded counter row (`id 3, P1, value 0`) carries P1.
- Step 5c (ad-name evidence) still joins on the brief NUMBER; on a store where PL and P1 numbers collide only the
  CONFLICT path protects it. Flagged for the lead before staged/125 ships.

## Open questions for the lead (not for Ludo)
- `product_profiles.id = 3` product_code NULL (see above): set it to `MR` (its short_name) or not?
- Puure residue in `brief_pipeline_winners` (114 rows): leave, or a data migration on the Mineblock DB?
- PUURE vs PL: `brief_pipeline_generated.product_code` stores `PUURE` while the naming code and the
  counter bucket are `PL`. The backfill tags rows with the stored value (`PUURE`) and the counter row
  id=2 as `PL` (rules json). Decide the canonical code before the keyed insert ships; a one-line data
  migration can normalise either way.
- `clickup_brief_resolutions` rows with no matching brief row cannot be attributed offline (the URL
  carries no list/product id). The script accepts `--p1-tasks <file>` (task ids/URLs exported from the
  P1 list) so the lead can attribute them without a live ClickUp call.
- `statics_im_counter` (legacy global) is left untagged deliberately.
- Should 124 be re-run as a sweep after a store's first boot (lazy tables appear later)? Today a
  ledgered migration runs once.

## Next action for the next session (one line)
Lead merges `order.lane-c.json` into Lane A's order + adds the `app.store_code` set_config to the runner; then S1-2 changes increment sites 1-4 above and moves `staged/125` in the same release.
