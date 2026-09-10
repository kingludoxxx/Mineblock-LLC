# The Store Brain (S4-SB)

One Brain per store, inside **that store's own Postgres and bucket**. Isolation is
physical: there is no shared knowledge table anywhere, no `store_id` column, and no
store parameter on any endpoint. Retrieval is scoped **by construction** — the API
runs inside the store's dashboard against the store's database, so there is nothing
to filter and nothing to get wrong.

## The three layers

| Layer | Tables | Written by | Read by |
|---|---|---|---|
| 1 RAW SOURCES | `kb_documents` | scrapers, imports, the CRM, `brain:import` | search, extraction |
| 2 INSIGHTS | `kb_insights`, `kb_insight_sources`, `kb_extraction_jobs`, `kb_embeddings` | extraction jobs (propose), reviewers (approve) | search, playbook citations |
| 3 PLAYBOOK | `playbook_products`, `playbook_entries`, `playbook_citations` | the product wizard / API only | pipelines |

**Layer 1 is immutable.** A document's identity is the sha256 of its bytes, so an
edited source is a NEW document and the original survives. Every row carries
`source`, `url`, `captured_at`, `product_code` and `scrape_job_id`. The body lives
in the bucket at

    stores/<STORE_CODE>/knowledge/raw/<source-slug>/<YYYY-MM-DD>/<sha256>.<ext>

`body_text` is kept in the database so search works with no bucket at all.

**The key is SERVER-DERIVED, always.** `ext` comes from `content_type` (allowlist:
`text/plain`, `text/markdown`, `application/json`, `text/html`, `text/csv`; anything
else is **422**), and a caller that supplies `ext` or `body_object_key` is refused
**422** rather than silently ignored. The key is then matched against an anchored
grammar with no `.` or `..` segment in it, so it cannot traverse. The
`stores/<STORE_CODE>/` prefix is what makes the bucket half of the isolation claim
real: two stores that share a bucket cannot collide, and since a body's key is its
hash, without the prefix identical bytes in two stores would be the SAME key and the
second ingest would overwrite the first store's archive.

**Layer 2 is proposed, then approved.** An insight with no source document is refused
— that is an assertion, not an insight. `status` is `proposed | approved | rejected`;
extraction NEVER auto-approves; `approved_by` is always recorded. Unapproved insights
are visible to a reviewer (`approved_only=false`) and invisible to every pipeline
that uses the default (R16).

**Layer 3 is curated.** Sections: `avatars, allowed_claims, forbidden_claims, angles,
hooks, voice_rules, visual_bible, proof_assets, competitors, offers`, plus
`checkout_url`. Each entry may `cite` insights — and **only APPROVED ones** (422
otherwise): layer 3 is what pipelines read, so an unapproved insight reaching one
through a citation is the approval gate defeated by the back door.
`product_profiles` (migration 120) stays the product registry; the playbook is its
editorial extension.

**The lock is real.** `POST /playbook/:product/lock` fixes the version a run cites:
while `locked_at` is set, `PUT` answers **423** and the version does NOT move, so the
locked version's CONTENT is fixed. Re-locking a locked playbook is refused too, never
a silent re-stamp. Editing needs `POST /playbook/:product/unlock`, which is a
`brain:approve` act and is logged (`brain.playbook.unlock`).

**Global research stays global.** brand-spy is not forked into stores. A store saves
its own insight and records `global_ref_kind` / `global_ref_id` pointing at the global
record, so the link is auditable and the global corpus is never copied.

## The API (one per store)

    GET   /api/v1/brain/search?q=…&product=&source=&insight_type=&from=&to=&approved_only=&type=&limit=
    GET   /api/v1/brain/documents            list
    GET   /api/v1/brain/documents/:id
    POST  /api/v1/brain/ingest               idempotent by content hash
    GET   /api/v1/brain/insights?status=&insight_type=&product=
    POST  /api/v1/brain/insights             always lands `proposed`
    PATCH /api/v1/brain/insights/:id         { status: approved | rejected, reason? }
    POST  /api/v1/brain/extract              { document_id } → an LLM proposes
    GET   /api/v1/brain/playbook/:product
    PUT   /api/v1/brain/playbook/:product     423 while locked
    POST  /api/v1/brain/playbook/:product/lock
    POST  /api/v1/brain/playbook/:product/unlock

Every search result carries **citations**: the document ids and the quotes it came
from. A result you cannot trace is not returned.

### Auth — and what each credential may DO

Either a dashboard session, **or** the header `X-Brain-Service-Token` matching this
pair's own `BRAIN_SERVICE_TOKEN` (constant-time compare, minimum 16 characters).
Tokens are per pair, in each pair's own environment, so store A's token is simply
wrong at store B (R4). Unset or too-short → **503**, never "allow". Read at request
time (R7): unset the variable and service access stops on the next call.

**The service token is READ-ONLY.** It exists so a pipeline can read; it is not a
reviewer. Anything that changes state answers **403 `service_read_only`**.

| | service token | `brain:read` | `brain:write` | `brain:approve` |
|---|---|---|---|---|
| `GET /search`, `/documents`, `/insights`, `/playbook/:p` | yes | yes | | |
| `GET /search?approved_only=false` | **403** | **403** | **403** | yes |
| `POST /ingest`, `POST /insights`, `POST /extract` | **403** | | yes | |
| `PUT /playbook/:p`, `POST …/lock` | **403** | | yes | |
| `PATCH /insights/:id` (approve / reject) | **403** | | | yes |
| `POST …/unlock` | **403** | | | yes |

`approved_by` is the **reviewing user's id** (a row in `users`), not a label —
`setInsightStatus` refuses without one, so there is no `approved_by="service"`.

Migration 128 granted a single flat `brain:access`, which gated reading raw
documents AND approving insights AND rewriting the playbook alike. Migration **131**
splits it: every role that already had `brain` gains `read` + `write`, and
`brain:approve` is granted to **no** role by default — SuperAdmin holds it through
`{"*":["*"]}`, and any other reviewing role is named deliberately (the statement is
in 131's header). `brain:access` is kept as "may reach the Brain at all".

## Search: two paths, one shape

Chosen at request time from what actually exists, never from a flag:

| provider (`OPENAI_API_KEY`) | `kb_embeddings.embedding` column | mode |
|---|---|---|
| set | present | `vector` — cosine over pgvector |
| set | absent | `keyword` |
| unset | either | `keyword` |

The keyword path is Postgres full-text over `search_tsv`, a GENERATED column on both
`kb_documents` and `kb_insights`, so it can never drift from the text it indexes.

**Both kinds are embedded.** `kb_embeddings` carries `document_id` **or**
`insight_id`, and both are written: an insight is embedded when it is approved, and
the vector search path backfills (bounded, on demand) any approved insight that has
no vector yet — a Brain approved before this existed, or while `OPENAI_API_KEY` was
unset, becomes searchable on the next query instead of answering `[]` for ever.
A provider failure RAISES; it never degrades into an empty result set.

**pgvector is not assumed.** The local Postgres the lanes test on does not have it
(`CREATE EXTENSION vector` → *extension "vector" is not available*). Migration 129 is
conditional: it creates the extension and `embedding vector(1536)` where the
extension is available and stops after the portable columns where it is not. The
whole vector block is inside one `EXCEPTION` handler, so a `CREATE EXTENSION` or
`ALTER TABLE` that fails on privileges leaves the portable shape and a NOTICE — it
does not fail the migration and therefore the deploy. `embedding_json` is written on
both shapes.

> **UNPROVEN, and it decides which path production takes.** "Render Postgres 16 ships
> pgvector" is asserted here and in `embeddingProvider.js` / `129_brain_embeddings.sql`
> and has been verified on NO live database — no live probe is allowed in this lane.
> **The integrator must confirm it on the SB database, in writing, before the train.**
> The same goes for the bucket: no real R2 round-trip has been watched, so the mirror
> is proven only against `bucketTarget()`'s refusals and the derived key.

**A store that GAINS pgvector later** never gets the column from the runner, which
keys on the ledger and will not re-run 129. That is what `npm run brain:vector-enable`
is for: idempotent, it creates the extension, column and index, backfills `embedding`
from the `embedding_json` every row already carries (skipping rows written by a
different model, whose dimension is part of the column type), and prints the counts.
It refuses with a reason and exit 1 when `DATABASE_URL` is unset, the database is
unreachable, the server has no pgvector, or `kb_embeddings` does not exist.

Embedding model: `text-embedding-3-small` (1536 dims). A different model needs its
own column — the dimension is in the type.

## Import CLI

    npm run brain:import -- --product <CODE> --source "operator research" <folder>

Ingests every `.md` / `.txt` / `.json` under the folder into the Brain named by
`DATABASE_URL`. Idempotent: a second run over an unchanged folder adds nothing. A
missing folder, an unknown product code, a missing `--source`, an unreachable
database or a folder with nothing ingestable all exit non-zero with the reason —
"0 new" is a result, never an error report.

## Rules this design answers

* **R5 / R15** — no product, store or brand literal anywhere in the Brain code. Codes
  arrive as data and are validated against `PRODUCT_CODES_JSON` through `storeConfig`.
* **R7** — `BRAIN_SERVICE_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the
  product catalogue are all read when a request is served.
* **R6** — migrations 128/129/130 are additive and idempotent and run on an empty
  database.
* **R16** — pipelines read approved insights and (once locked) a locked playbook
  version; `POST /brain/playbook/:product/lock` stamps the version a run cites.
* **R4** — one service token per pair, never shared, never falling back. `R2_BUCKET_NAME`
  is per pair too: the Brain refuses the shared fallback bucket, and refuses to mirror
  at all when `STORE_CODE` is unset (an unprefixed object could collide). Ingest still
  succeeds — the database is the index, the bucket is the archive — and logs why it
  did not mirror.
* **New env** — `BRAIN_SERVICE_TOKEN` (per pair, ≥16 chars) and the five `R2_*` keys now
  have slots in `render.yaml`, `.env.example` and `server/config/env.SB.example`.

## Migrations

| # | file | what |
|---|---|---|
| 128 | `128_brain_kb_core.sql` | `kb_documents`, `kb_insights`, `kb_insight_sources`, `kb_extraction_jobs`, tsvector columns, `brain:access` |
| 129 | `129_brain_embeddings.sql` | `kb_embeddings`; pgvector column + ivfflat index where the extension exists |
| 130 | `130_brain_playbook.sql` | `playbook_products`, `playbook_entries`, `playbook_citations`, the global-research back-reference |
| 131 | `131_brain_permissions.sql` | splits `brain:access` into `read` / `write` / `approve` (grants read + write; approve to no role) |

`order.json` goes from 111 to 115 entries; the next free HUB number is **132**.

## Tests

    node server/tests/brain/brain-routes.mjs      routes, auth, ingest, insights, playbook, extraction
    node server/tests/brain/brain-isolation.mjs   two stores, two databases, two processes
    node server/tests/brain/brain-import.mjs      the import CLI, twice, plus its failure paths
    node server/tests/brain/brain-vector.mjs      the pgvector path, incl. insights in vector mode (SKIPs with a reason if no such server)

The adversarial review's own probes are kept, guarded, under
`server/tests/brain/probes/` — see that folder's README for the before/after table.

`brain-vector.mjs` looks for a pgvector Postgres at `BRAIN_VECTOR_PGURL`
(default `postgres://postgres@127.0.0.1:5434`). See PROOF-S4-SB.md for building one
into a private copy of the pg16 distribution without touching the shared cluster.
