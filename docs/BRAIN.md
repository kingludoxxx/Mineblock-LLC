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
in the bucket at `knowledge/raw/<source-slug>/<YYYY-MM-DD>/<sha256>.<ext>` (the same
flat-prefix convention as the existing R2 mirrors, e.g. `brand-spy/videos/<id>.mp4`);
`body_text` is kept in the database so search works with no bucket at all.

**Layer 2 is proposed, then approved.** An insight with no source document is refused
— that is an assertion, not an insight. `status` is `proposed | approved | rejected`;
extraction NEVER auto-approves; `approved_by` is always recorded. Unapproved insights
are visible to a reviewer (`approved_only=false`) and invisible to every pipeline
that uses the default (R16).

**Layer 3 is curated.** Sections: `avatars, allowed_claims, forbidden_claims, angles,
hooks, voice_rules, visual_bible, proof_assets, competitors, offers`, plus
`checkout_url`. Each entry may `cite` insights. `product_profiles` (migration 120)
stays the product registry; the playbook is its editorial extension.

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
    PUT   /api/v1/brain/playbook/:product
    POST  /api/v1/brain/playbook/:product/lock

Every search result carries **citations**: the document ids and the quotes it came
from. A result you cannot trace is not returned.

### Auth
Either a dashboard session with the `brain:access` permission (migration 128 grants
it to `Team - Full Access`; SuperAdmin already has `{"*":["*"]}`), **or** the header
`X-Brain-Service-Token` matching this pair's own `BRAIN_SERVICE_TOKEN`
(constant-time compare, minimum 16 characters). The CRM reads its store's Brain
through this API with that token; it never opens Postgres. Tokens are per pair, in
each pair's own environment, so store A's token is simply wrong at store B (R4).
Unset or too-short `BRAIN_SERVICE_TOKEN` → **503**, never "allow". Read at request
time (R7): unset the variable and service access stops on the next call.

## Search: two paths, one shape

Chosen at request time from what actually exists, never from a flag:

| provider (`OPENAI_API_KEY`) | `kb_embeddings.embedding` column | mode |
|---|---|---|
| set | present | `vector` — cosine over pgvector |
| set | absent | `keyword` |
| unset | either | `keyword` |

The keyword path is Postgres full-text over `search_tsv`, a GENERATED column on both
`kb_documents` and `kb_insights`, so it can never drift from the text it indexes.

**pgvector is not assumed.** Render Postgres 16 has it; the local Postgres the lanes
test on does not (`CREATE EXTENSION vector` → *extension "vector" is not available*).
Migration 129 is conditional: it creates the extension and `embedding vector(1536)`
where the extension is available and stops after the portable columns where it is
not. `embedding_json` is written on both shapes, so a database that gains pgvector
later can be backfilled from rows already stored.

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
* **R4** — one service token per pair, never shared, never falling back.

## Migrations

| # | file | what |
|---|---|---|
| 128 | `128_brain_kb_core.sql` | `kb_documents`, `kb_insights`, `kb_insight_sources`, `kb_extraction_jobs`, tsvector columns, `brain:access` |
| 129 | `129_brain_embeddings.sql` | `kb_embeddings`; pgvector column + ivfflat index where the extension exists |
| 130 | `130_brain_playbook.sql` | `playbook_products`, `playbook_entries`, `playbook_citations`, the global-research back-reference |

`order.json` goes from 111 to 114 entries; the next free HUB number is **131**.

## Tests

    node server/tests/brain/brain-routes.mjs      routes, auth, ingest, insights, playbook, extraction
    node server/tests/brain/brain-isolation.mjs   two stores, two databases, two processes
    node server/tests/brain/brain-import.mjs      the import CLI, twice, plus its failure paths
    node server/tests/brain/brain-vector.mjs      the pgvector path (SKIPs with a reason if no such server)

`brain-vector.mjs` looks for a pgvector Postgres at `BRAIN_VECTOR_PGURL`
(default `postgres://postgres@127.0.0.1:5434`). See PROOF-S4-SB.md for building one
into a private copy of the pg16 distribution without touching the shared cluster.
