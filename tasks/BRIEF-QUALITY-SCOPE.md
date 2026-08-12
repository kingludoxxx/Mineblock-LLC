# Brief Pipeline — output quality scope

**Opened 2026-08-11.** Operator report: *"the generator always uses the same
angle"* and *"hooks are generated pretty randomly, they always say the same
thing."* Both are correct. This document records what was **measured**, the
three defects behind it, and the fix for each with its test.

Measured against the full corpus of **41 generated briefs** (Mineblock DB, all
`product_code=PUURE`, all `iteration_mode=clone`).

---

## Evidence

### 1. The `angle` field does not change the output

Share of briefs in each angle whose BODY contains each device:

| angle | n | collagen | 8mm | wavelength | scaffold | surgeon | $99 |
|---|---|---|---|---|---|---|---|
| Promo | 22 | 86% | 68% | 68% | 59% | 68% | 55% |
| The Collagen Scaffold Collapse | 8 | 100% | 75% | 100% | 100% | 100% | 88% |
| The Surgeon's Secret | 5 | 100% | 80% | 100% | 80% | 80% | 100% |
| $2,417 Wasted on the Surface | 2 | 100% | 100% | 100% | 100% | 0% | 50% |
| Get Your Closet Back | 1 | 100% | 100% | 100% | 0% | 100% | 100% |

*Get Your Closet Back* is a wardrobe/identity angle and still delivers the
mechanism stack at 100%. Selecting a different angle changes the label, not the
script.

### 2. Every script draws the same proof stack

Across the 9 recurring devices (`collagen, 8mm, wavelength, scaffold, surgeon,
$99, 20,000, red light, three`):

```
mean 6.9 of 9 devices per script
34/41 briefs use 6 or more of the same 9
collagen 38/41 · lift 39/41 · red light 36/41 · wavelength 34/41
8mm 31/41 · surgeon 31/41 · scaffold 29/41 · $99 28/41 · $20,000 22/41
```

The clone mechanism itself is healthy — body OPENINGS are varied ("I almost
booked…", "I performed over…", "Reply to Elia's…", "This is Linda.") because it
follows each different source faithfully. The shell varies; the substance does
not.

**Cause:** the whole master brief is injected on every generation, so the model
reaches for the same strongest facts every time. Nothing scopes the facts to the
selected angle.

### 3. Hooks converge by construction

- Generation says *"Vary hooks by ENTRY POINT"*.
- A post-generation validator scores hooks 1-10 on thread continuity **against
  the body's single first sentence**, and its rubric caps a topic shift at 4-5:
  *"A hook that is punchy and on-brand but leaves the first sentence sounding
  like a topic change is a 4-5, NOT a 7."* Pass needs >= 7.
- On failure the rewrite instructs: *"Vary them by EMOTIONAL ANGLE and PHRASING
  on that SAME setup … **NEVER by topic**."*

So variety is generated, scored as a defect, then rewritten out. Searching the
whole 19k prompt: `distinct`, `different from each other`, `diversity`,
`similar`, `overlap` — **all ABSENT**. There is a convergence force and no
divergence force.

Structural root: if all five hooks must hand off to one fixed sentence with no
bridge, only one topic can ever be "continuous". Five topically distinct hooks
and that rule are mutually exclusive.

### 4. Two fields never vary

- `format` = **Mashup on 41/41** — hardcoded at `briefPipeline.js:4597`.
- `aggressiveness` = **medium on 41/41**.

---

## Fixes

### F1 — `format` hardcode  *(small, isolated)*

`briefPipeline.js:4597` writes `format: 'Mashup'` into every naming convention
regardless of the reference's real format. Derive it the way `briefType` is
already derived, falling back to `Mashup` only when unknown.

**Test:** generate from a reference whose format is not Mashup; assert
`naming_convention` and the `format` column carry the derived value. Regression:
a reference with no detectable format still yields `Mashup`.

### F2 — hook territories  *(prompt + validator, must ship together)*

Prompt-only changes will be undone by the hardcoded validator, so both halves
land in one change.

1. New step before hooks: emit **5 named, mutually exclusive territories**
   drawn from the SOURCE and product brief — e.g. enemy, mechanism, humiliation
   moment, proof/authority, offer shock. For a clone, H1's territory is fixed as
   the source's readapted signature scroll-stopper.
2. Each hook carries its territory in the JSON, so diversity is inspectable.
3. Delete *"vary by phrasing, NEVER by topic"* from the rewrite.
4. Validator gains a second axis:
   - continuity judged against the body's opening **beat**, not its first
     sentence; a one-clause bridge is allowed; drop the 4-5 cap on topic shifts
   - **distinctness** (new): pairwise penalty when two hooks share a territory
     or lead with the same noun/claim
   - fail on EITHER axis

**Test:** same source ad, before/after, side by side. Pass = 5 distinct
territories present AND continuity holds.

**Risk:** the blend gate was added to fix hooks that did not connect to the body
at all. Loosening continuity without landing distinctness at the same time
reintroduces that. Ship together or not at all.

### F3 — angle-scoped proof sets  *(largest; not started)*

Give each angle in the product profile its own slice: which mechanism it may
lean on, which price framing, which objection it kills. Pass the generator only
that slice instead of the entire master brief.

**Open tension the operator must settle:** the standing instruction is to give
the model 100% of the product context rather than a distilled summary
(`feedback_principle_based_prompts`, July 2026), because a distilled field
summary produced worse output than the full brief. This finding pushes the other
way. The reconciliation is probably *full brief + an angle-scoped emphasis
directive* rather than a trimmed brief — full context, ranked, not truncated.
**Do not implement until that is decided.**

**Test:** generate the same source under three different angles; the proof-stack
overlap between them must drop from today's ~100%.

---

## Status

- [x] F1 format hardcode — SHIPPED + VERIFIED 2026-08-12: a real generation now
      names `UGC` (`PL - B0093 - NN - Menopause - TSS - UGC - ...`) where the
      corpus was Mashup on 41/41.
- [x] F2 hook territories — SHIPPED + VERIFIED 2026-08-12. Two runs on the same
      source each returned five DISTINCT territories (humiliating moment /
      proof-authority / enemy / mechanism / price shock / identity flip). The
      BEFORE run on the same ad had no territory field and used the ex-husband
      angle twice (H1 and H5).
      Live prompt after patch: md5 `4a2b070db9dc23f6f58d430b80859309`.
      Rollback: `BACKUP-scriptClone.json`, md5 `8d81db11102143f946d87971a43e79bf`.
- [ ] F3 angle-scoped proof sets — BLOCKED on the operator's call re: full vs
      scoped product context

## Notes

- Live prompt backup before any edit: `scriptClone.json` md5
  `8d81db11102143f946d87971a43e79bf`, 19,434 chars.
- `iteration_mode` is `clone` on 41/41 — iterate mode is untested in production.
