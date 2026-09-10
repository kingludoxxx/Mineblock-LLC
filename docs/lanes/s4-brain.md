# Lane handoff — S4-SB (the Store Brain)   last session 2026-09-11   commit see `git log day2/s4-brain`

## Where I stopped
Slice complete and committed on `day2/s4-brain` (worktree `/Users/ludo/wt-s4-brain`).
Nothing pushed, nothing deployed, no live service touched.

Delivered:
* `server/migrations/128_brain_kb_core.sql`, `129_brain_embeddings.sql`,
  `130_brain_playbook.sql`, registered in `order.json` (111 → 114 entries;
  next free HUB number is now **131**).
* `server/src/services/brain/brainSchema.js`, `…/embeddingProvider.js`,
  `server/src/services/brainStore.js`, `brainSearch.js`, `brainExtract.js`.
* `server/src/middleware/brainAuth.js`, `server/src/routes/brain.js`,
  mounted in `server/src/routes/index.js:76`.
* `server/scripts/brain-import.mjs` + `npm run brain:import`.
* `server/tests/brain/{brain-routes,brain-isolation,brain-import,brain-vector}.mjs`
  (`_boot.mjs` is the isolation test's host, guarded by `BRAIN_TEST_HOST=1`).
* `docs/BRAIN.md`, proof pack `~/tasks/multistore-hub/briefs/out/PROOF-S4-SB.md`.

## What is proven
By execution, output in the proof pack: 108 checks green across the four Brain
scripts; migrations suite still 76/76; smoke 14/14; sandbox 8/8; store-code 26/27
(see the open item). Both search paths proven: the tsvector fallback on the shared
cluster (no pgvector) and the real pgvector path on a private Postgres built for it.

## What is NOT proven
* No R2 round-trip. `POST /brain/ingest` mirrors the raw body to the bucket only
  when R2 is configured, and the failure is logged, not fatal. Nobody has watched a
  real object land in a real bucket — that needs a store with R2 credentials.
* No real LLM call. Extraction is proven with an injected client, both on the happy
  path and on the unreachable-model path. `ANTHROPIC_API_KEY` unset answers 503.
* No real OpenAI embedding call. The provider is proven with an injected `fetchImpl`
  (key in a header, non-2xx raises); the vector maths is proven with a deterministic
  stand-in on real pgvector.
* No UI. This slice is API + CLI only; there is no Brain page yet.

## Open questions for the lead (not for Ludo)
1. **`server/tests/store-code/a6-no-read-path.test.mjs` is unsatisfiable for any lane
   that ships server code.** It asserts that nothing under `server/src/` appears in
   the lane's diff or working tree. On a clean `hub/main` checkout it passes; on any
   feature branch it reports that branch's `server/src` files as violations. It is a
   Lane-C scope guard that was merged into the shared suite. I did not touch another
   lane's test (R35). Suggested repair for the integrator: scope the sweep to the
   store-code lane's own commits, or gate it behind `LANE_BASE_COMMIT`.
2. `run-all.mjs`'s preflight CREATES every database it finds named in a DSN inside a
   test file. That silently defeated an "unreachable database" failure path until the
   name was built at runtime (`brain-import.mjs` C5.4). Worth a note in the runner:
   a literal DSN in a test is a database the runner will conjure. The preflight also
   creates a database literally named `${NAME}` from some other file's template string.
3. `BRAIN_SERVICE_TOKEN` needs a slot in the per-pair env template and the manifest
   (R4: unique per pair, never a platform fallback). Not added here — that file
   belongs to the identity/provisioner lane.
4. Playbook LOCK exists (`POST /brain/playbook/:product/lock`) but no pipeline reads
   it yet; whoever wires R16's run manifest should quote `playbook_products.version`.

## Next action for the next session
Wire a Brain page into the dashboard (review queue for `proposed` insights + the
playbook editor), or wire the first real pipeline to read `approved_only=true`
search results and cite them in its run manifest.
