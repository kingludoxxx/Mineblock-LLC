# Scope: pasted-link briefs must carry their reference video (modal + ClickUp)

## Prompt to myself
A brief generated from a pasted Facebook Ad Library link must behave EXACTLY like a
League-imported brief: the detail modal shows the **SOURCE REFERENCE** video panel, and the
ClickUp push writes a **`Reference video: <url>`** line — not the empty
`Reference: (paste competitor video link here)` placeholder. Find why the pasted-link path
doesn't and fix it so it works every time, then verify live (modal + a real ClickUp push).

## Symptoms (operator report, B0066)
1. Detail modal for the pasted-link brief has ORIGINAL SCRIPT but **no SOURCE REFERENCE
   panel** (League brief B0058 has one: video player + brand + "OPEN IN SOURCE").
2. Pushed B0066 to ClickUp → the description shows `Reference: (paste competitor video link
   here)` — the video was **not** added.

## Root cause (single bug, confirmed from code + prod logs)
The reference ROW is created correctly (prod log 19:52Z: `ref c4dfa0f9… media mirrored to R2:
video, thumbnail`), but the winner is never LINKED to it, so `winner.reference_id` stays NULL.

`briefPipeline.js:4116` reads the wrong field:
```js
const ref = await importLeagueAdAsReference({...});   // returns { reference, alreadyExists }
if (ref?.id) referenceIdForWinner = ref.id;           // ref.id is UNDEFINED
```
`importLeagueAdAsReference` returns `{ reference, alreadyExists }` (see :6876), so the id is
`ref.reference.id`. Reading `ref.id` yields undefined → `referenceIdForWinner` stays null →
the winner INSERT stores `reference_id = NULL`.

That single NULL starves all three consumers, which ALL key off `winner.reference_id`:
- **Modal panel** — GET `/generated` (:4801) and `/generated/:id` (:4865) LEFT JOIN
  `references r ON w.reference_id = r.id`; NULL ⇒ `brief.reference = null` ⇒ panel hidden
  (BriefDetailModal.jsx:374 renders only when `brief.reference` has video/thumb/source).
- **ClickUp line** — push resolver (:3584-3595) JOINs `winner.reference_id`; NULL ⇒ no
  `video_url`/`source_url` ⇒ falls to `Reference: (paste competitor video link here)` (:3641).
  With the link, :3636 emits `Reference video: <R2 url>` (the durable mirrored copy).
- **Dedup grouping** (:279) groups by `reference_id`; NULL rows are skipped.

## The fix
One line: `briefPipeline.js:4116` → `if (ref?.reference?.id) referenceIdForWinner = ref.reference.id;`
Everything downstream already exists and works (proven by League briefs). No schema/UI change.

## Verification bar (live, not assumed)
1. Paste `id=1576753040701353` → Generate → open the new card → **SOURCE REFERENCE panel
   renders with the video** (like B0058).
2. Push that card to ClickUp → description first line is **`Reference video: <url>`**, not the
   paste-prompt placeholder.
Both confirmed by driving the operator browser + reading prod logs.

## Note on B0066
B0066 was created by the buggy code, so its winner row already has `reference_id = NULL` in
prod (can't be backfilled from the dev box — prod DB is IP-locked). The fix applies to NEW
generations. To get a correct card now: re-paste the link and push the fresh card (or I can
patch the existing ClickUp task's description directly via the ClickUp API on request).
