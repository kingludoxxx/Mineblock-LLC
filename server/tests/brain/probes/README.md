# Brain review probes (S4-SB2)

These two scripts are the **adversarial review's own probes**, kept so the findings
they exposed stay reproducible. They are **probes, not tests**: they PRINT what the
Brain does rather than asserting it, which is why each one is guarded and
`run-all.mjs` skips it with a reason.

    BRAIN_PROBE=1 node server/tests/brain/probes/p0-1-vector-insights.mjs   # needs :5434 (pgvector)
    BRAIN_PROBE=1 node server/tests/brain/probes/p0-p1-http-probes.mjs      # needs :5433

Each drops and recreates its own scratch database (`sb2_vecprobe`, `sb2_httpprobe`).

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
