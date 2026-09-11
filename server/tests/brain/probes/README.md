# Brain review probes (S4-SB2 and S4-SB3)

These scripts are the **adversarial reviews' own probes**, kept so the findings they
exposed stay reproducible. They are **probes, not tests**: they PRINT what the Brain
does rather than asserting it, which is why each one is guarded and `run-all.mjs`
skips it with a reason.

    # first pass (S4-SB2)
    BRAIN_PROBE=1 node server/tests/brain/probes/p0-1-vector-insights.mjs   # needs :5434 (pgvector)
    BRAIN_PROBE=1 node server/tests/brain/probes/p0-p1-http-probes.mjs      # needs :5433
    # second pass (S4-SB3)
    BRAIN_PROBE=1 node server/tests/brain/probes/sb3-second-pass.mjs        # needs :5433
    BRAIN_PROBE=1 node server/tests/brain/probes/sb3-lock-race.mjs          # needs :5433
    BRAIN_PROBE=1 node server/tests/brain/probes/sb3-vector-probe.mjs       # needs :5434 (pgvector)

Each drops and recreates its own scratch database (`sb2_vecprobe`, `sb2_httpprobe`,
`sb3_httpprobe`, `sb3_lockrace`, `sb3_vecprobe`).

Every probe resolves the repo from its OWN location. Two of them used to name
`/Users/ludo/wt-s4-brain` outright, so a copy running in any other worktree imported
the original lane's code and proved nothing about the tree it was sitting in.

## What they showed, before and after

`p0-1-vector-insights.mjs` — one document plus one APPROVED insight on a real
pgvector server, asked for in both modes.

| | before (`a680936`) | after |
|---|---|---|
| `kb_embeddings` rows with `insight_id` | `0` | `1` |
| keyword mode | `["document:1","insight:1"]` | `["document:1","insight:1"]` |
| vector mode | `["document:1"]` | `["document:1","insight:1"]` |
| `type=insight` in vector mode | `[]` | `["insight:1"]` |

`p0-p1-http-probes.mjs` — the real router over HTTP.

| probe | before | after |
|---|---|---|
| service token PATCH → approved | `200 approved_by="service"` | `403 service_read_only` |
| service token `approved_only=false` | `200`, proposed visible | `403 approval_scope` |
| service token PUT / lock playbook | `200` | `403 service_read_only` |
| session PUT citing a PROPOSED insight | `200` | `422 citation_not_approved` |
| PUT on a LOCKED playbook | `200`, content rewritten, version bumped | `423 playbook_locked`, content and version unchanged |
| `POST /playbook/:p/unlock` | `404` (no such route) | `200`, `locked_at: null` |
| `ext: 'txt/../../../../brand-spy/videos/owned'` | `201`, traversal in the key | `422 ext_not_yours` |
| `body_object_key: '../../../other-store/secret.txt'` | `201`, stored verbatim | `422 key_not_yours` |
| honest ingest | `knowledge/raw/…` | `stores/SA/knowledge/raw/…` |
| service token GET search / documents / playbook | `200` | `200` (unchanged — it is a READ credential) |

The properties themselves are asserted, so they cannot come back green, in
`brain-routes.mjs` (B10.1–B10.34) and `brain-vector.mjs` (V6, V7).

## Second pass — what the S4-SB3 probes showed, before and after

`sb3-second-pass.mjs` — the real router over HTTP, four credentials.

| probe | before (`3c7957c`) | after |
|---|---|---|
| `GET /insights`, service / read / write | `200` proposed + rejected + approved | `200` **approved only** |
| `GET /insights?status=proposed`, same three | `200`, full bodies | `403 approval_scope` |
| `GET /insights`, reviewer | all three | all three (unchanged — the gate is the permission) |
| `?provider=` / `?provider=anything` | `200 mode=keyword` (silent downgrade) / `500` | `400 unknown_parameter` |
| NUL byte in `q` | `500 internal` | `400 bad_text` |
| `from=not-a-date`, `to=2026-13-99` | `500 internal` | `400 bad_date`, naming the parameter |
| `BRAIN_SERVICE_TOKEN` with surrounding whitespace | `401 bad_service_token`, for ever | `503 service_token_whitespace`, naming the variable |
| `STORE_CODE="../evil"` | `{"ok":true,"prefix":"stores/../EVIL/"}` | `{"ok":false}`, reason names `STORE_CODE`; `keyPrefix()` null |
| locked playbook citing an insight rejected afterwards | `cites=[4]` | `cites=[]`, `stale_cites=[{insight_id:4,status:"rejected"}]` |
| `rejected → approved` | `rejected_reason` silently NULLed, no record | cleared, but the reason is kept in `metadata.review_history` |

`sb3-lock-race.mjs` — two connections, a controlled interleave: connection 2 takes
the LOCK the instant connection 1's lock CHECK resolves.

| | before | after |
|---|---|---|
| lock granted while the PUT was in flight | `GRANTED` at +14 ms | **blocks on the row** for the whole 2500 ms ceiling |
| the PUT | `RETURNED version=2` | `RETURNED version=2`, and the lock lands *after* it |
| a lock was granted and the content then changed under it | **true** | **false** |
| the other order (lock commits before the check) | `423` | `423` (unchanged, and now genuinely re-read inside the transaction) |

`sb3-vector-probe.mjs` — needs pgvector, because both findings are invisible without it.

| probe | before | after |
|---|---|---|
| `?provider=anything` on a pgvector store | `500` | `400 unknown_parameter` |
| `?provider=` on a pgvector store | `200 mode=keyword` while the store is really `vector` | `400` |
| ONE service `GET /search` with 30 unembedded insights | **31 provider calls**, response says nothing | **11** (10 + the query's own), `backfill: {embedded:10, remaining:20, limit:10}` |

The properties themselves are asserted, so they cannot come back green, in
`brain-routes.mjs` (B11.1–B11.29, B12.1–B12.4) and `brain-vector.mjs` (V8, V9).
Run against a pinned archive of `3c7957c`, that block is **48 failures**; on the
fixed tree it is 0.
