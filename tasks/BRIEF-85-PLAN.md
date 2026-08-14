# Plan: every batch at 8.5

**Written 2026-08-14.** Operator's bar: batches that score 8.5, consistently —
"we can do much better than this."

## Why 8.5 is provable, not aspirational

The tool has already produced 8.6 and 8.7 — twice, in the same batch, from rich
sources, with the selection brain on. The 6.0–6.8 briefs differ from the 8.6+
briefs in exactly three measured ways, none of which is "the generator is not
good enough":

| Measured drag | Evidence (last two batches) |
|---|---|
| Near-duplicate hooks | DUPLICATE_HOOK on 4 of 5 briefs; HOOKS_ALIKE on 2 |
| Selection brain offline / thin sources | triage overflowed at pool=100 → silent tier fallback → an offer card ("viral skin-tone foundation") entered the batch; LENGTH_47-63% + LOW_SPECIFICITY cluster on offer-shaped sources |
| Source inventory exhaustion | seranova: 6 unused EN candidates, 1 clonable; the four similar-product brands' story ads are largely already briefed |

A clone cannot be much better than its source. 8.5 = make rich-source,
brain-on, dupe-free the NORM. That is a selection and inventory problem plus
two small enforcement gaps — not a rewrite of the generator.

**Definition of done (measurable):** a 5-brief batch with avg ≥ 8.0, floor
≥ 6.5, at least two briefs ≥ 8.5, zero spec/ungrounded hooks, zero
DUPLICATE_HOOK flags delivered. Two consecutive batches meeting this = target
held.

---

## P1 — Restore and harden the selection brain (~half day) — BIGGEST LEVER

The fit triage IS the input-quality control, and it silently died at
triagePool=100 (single batched Haiku call overflowed max_tokens → parseTriage
null → tier fallback). Every downstream score inherits that failure.

1. **Chunk the triage**: batches of 25 candidates per call, results merged;
   a failed chunk falls back for ITS 25 only. `max_tokens` sized to chunk.
2. **Substance is part of fit**: each candidate line carries its spoken-length;
   prompt rule: a bare offer/discount card with no narrative cannot score
   above 5, whatever its tier. (Keep the B0160 lesson: under a DIRECTED angle
   a thin source may still carry the angle's structure — the prompt already
   says this; keep it.)
3. **Directed-angle runs default minFit 7** (autopilot default stays 6).
4. **Report triage health**: the run response and Slack line state
   `triaged: n/m chunks ok` — a fallback must be VISIBLE, never silent.

Acceptance: dry run at pool=100 returns a fit for 100/100; offer cards ≤ 5;
an angle-directed dry run picks only fit ≥ 7; killing the key mid-run yields a
visible "triage degraded" line, not a quiet tier-sorted batch.

## P2 — Duplicates die like lies do (~half day)

We drop fabricated hooks; near-duplicates still ship and cost 4 of 5 briefs.
Same treatment:

1. Deterministic near-dup detector (shared in briefScore.js): token-set
   overlap ≥ 0.6 or identical first five words — pure, unit-testable.
2. Extend the existing DROP rule: duplicates removed whenever ≥ 3 distinct
   hooks remain; ids renumbered; kept-and-flagged only below the floor.
   (Architecture-aware: FRAMED_LIST/REVERSAL frames are exempt — their hooks
   are SUPPOSED to share the frame; the detector compares beyond the frame
   words for those.)
3. Golden harness: new assertion "no near-duplicate hooks delivered".

Acceptance: harness green incl. the new assertion; next batch shows zero
DUPLICATE_HOOK flags on delivered briefs.

## P3 — CTA style match (~half day) — the last known-bad prompt rule

Still live, verbatim: "carry over EVERY pressure device … stack them, never
trade." Measured cost: the same offer block recited in 40 of 43 corpus briefs.
Replace with source-parity: the close matches the source's close in length and
register; offer facts only where the source's close has room. Harness
assertion: close length within 2x of the source's close; ≤ 2 offer facts when
the source close carries one.

## P4 — Feed the ceiling: fresh inventory (operator + ~1h tool assist)

The strongest lever no code can substitute: the four similar-product brands'
proven story ads are consumed — that is dedup WORKING. To raise the ceiling:

1. Operator follows 5–10 new League brands in adjacent women-40+ problem
   spaces (LED masks, neck/jawline devices, arm/leg firming, posture/support
   wear, at-home skin devices). The tool can assist with a one-shot scout:
   rank candidate brands by narrative-ad density from ad-library search.
2. Autopilot default gains a mild freshness bias (prefer sources < 45 days)
   so new inventory is consumed while competitors' tests are still live.

Acceptance: a dry run across the widened set yields ≥ 3 picks at fit ≥ 8 —
the level the four current brands can no longer supply.

## P5 — Batch as a portfolio (~2h)

Composition constraint in the cap: a batch avoids two briefs of the same
architecture+angle-territory when alternatives of fit ≥ 7 exist. Attacks the
"batch feels samey" cost directly at zero prompt risk.

## P6 — Prove it and keep it proven (~2h)

1. Extend the golden harness run to REPORT batch-style metrics (avg, floor,
   flag counts) so a deploy shows its quality delta, not just pass/fail.
2. Monday Slack self-report: approval rate by brand/angle, fit-vs-approval
   correlation, flag trend. The learning loop's dashboard — this is where
   "are we at 8.5" stops being a question for Claude and becomes a number.

---

## Order and effort

| Step | Effort | Dependency |
|---|---|---|
| P1 triage chunking + substance | 0.5 day | none — first |
| P2 duplicate drop | 0.5 day | none |
| P3 CTA parity | 0.5 day | none |
| P4 new brands | operator 30min + tool 1h | parallel |
| P5 portfolio cap | 2h | after P1 |
| P6 metrics + Monday report | 2h | last |

Total: ~2 working days of tool work + one operator session for brands.

## What is deliberately NOT in this plan

- No new prompt rules beyond P3's replacement. Every sameness problem this
  week traced to selection, enforcement, or inventory — not to missing prompt
  text — and each added rule has cost an interaction bug.
- No auto-approve. The operator reviews; the loop learns from it.
- Layer-2 performance data (Meta vs winner-button) stays a separate decision;
  it makes the tool smarter over months but is not what stands between 6.8
  and 8.5 today.
