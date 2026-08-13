# Brief Pipeline: 7 → 10

**Written 2026-08-13.** Operator's bar: *"a tool a $100 million company would use."*
This is an honest scope of the gap, ordered by leverage.

---

## The thesis

The gap is not features. It is that **the tool cannot tell when it is broken, and
cannot tell whether its output works.**

Evidence, all from this week and all measured:

- `overall_score` was a hardcoded constant — `8.4` on **41 of 41** briefs — and
  survived months because nothing ever checked it.
- Migrations had been failing on **every boot since the fork** (4 of 96 applied).
  Nobody knew.
- Transcription was **completely dead on Puure** for days. Found by accident.
- The League "already briefed" label was blank because the fork left the table
  empty and recorded it as *"no functional impact."*
- Three regressions were shipped in a single evening (territory padding →
  spec hooks; distinctness gate → broke framed-list hooks). Each was caught only
  because someone manually ran a generation and read the output.

A 7 is a tool that produces good work when watched. A 10 is a tool that tells
you when it is wrong and gets better on its own. Everything below serves that.

---

## Layer 1 — the tool cannot tell when it is broken

**This is first, and not because it is virtuous. It is what makes everything
else safe to build fast.** Every regression this week would have been caught
before deploy by a harness that takes an hour to write.

### 1.1 Golden-set regression harness
A fixed set of ~6 reference scripts spanning the real structures (story VSL,
framed listicle, reversal/fake-out, promo, demo, long VSL >10k chars). On every
deploy, generate against each and assert PROPERTIES, not exact text:

- zero spec hooks (mechanism, wavelengths, millimetre depth)
- hook count matches the classified architecture (framed list → 3 same-frame)
- every hook traceable to the body; POV matches the body
- length parity within a band of the source
- score present and not null
- CTA carries no offer fact the source's close had no room for

Fails the deploy, or reports loudly. **The distinctness-vs-architecture conflict
would have been caught by assertion 2 automatically.**

### 1.2 Capability self-check at boot
Report to Slack on start: transcription providers reachable, R2 canary, DB
migrations complete, ClickUp reachable, Gemini/Vertex/OpenAI keys present.
Transcription was dead for days because nothing said so. One message per boot.

### 1.3 Never fall back to a plausible value
Already applied to the score (an unscored brief now stores NULL and reads as
unscored). Audit the rest of the pipeline for the same pattern — a fabricated
default that looks like a real measurement is worse than an error.

---

## Layer 2 — the tool cannot learn

**The single biggest differentiator, and the longest build.**

Today: brief → ClickUp card → editor → launched ad → **and the chain ends.**
Nothing flows back. So "quality" means proxies plus the operator's taste. The
tool will be exactly as smart in six months as it is today.

### 2.1 Close the loop
Persist the chain brief → card → creative → ad → spend/ROAS. The ad launcher and
Meta integration already exist on the Mineblock side; the missing link is
recording which brief produced which creative and reading performance back.

### 2.2 What that unlocks, in order of value
- **Reference-fit triage trained on outcomes** rather than a model's guess about
  which competitor ads are worth cloning.
- **Score calibration against reality.** Today the weights are my judgement.
  With outcomes they become fitted.
- **Angle and source selection informed by what converts** — the operator's
  observation that similar-product brands produce better briefs becomes a
  measured fact rather than an impression.
- **Autopilot that improves.** Without this, Autopilot is a scheduler. With it,
  it is a strategist.

---

## Layer 3 — the creative model (the sameness)

Measured: mean **6.9 of the same 9 proof devices** per script; 34/41 use six or
more; every angle ships the same stack (100% overlap, 73% after a partial fix).

### 3.1 The angle must own its evidence — INCLUDING EXCLUSIONS
The root cause. Every generation receives the whole master brief and picks the
strongest five facts, which is rational. Nothing tells it to argue a DIFFERENT
case. Emphasis alone moved overlap 100% → 73% and stalled.

Difference comes from what is **withheld**. Each angle needs its enemy, its
mechanism-of-choice, its proof, its objection — and its forbidden material.
Proven live tonight: ban the mechanism from hooks and they all became price
hooks. Partition the material or the model just relocates its laziness.

⚠️ Tension to settle: the standing instruction is to give the model 100% of the
product context, because a distilled summary produced worse output. The
reconciliation is full brief + an angle-scoped exclusion directive — ranked and
partitioned, not truncated.

### 3.2 Source diversity
26 of 40 briefs came from **two brands**, out of 18 followed and 952 active
video ads. A different source is a different story for free. Autopilot's cap
starts this; selection should actively prefer sources unlike recent briefs.

### 3.3 Iterate mode has never been run — 0 of 41
Clone reproduces a competitor. Iterate varies OUR winner. The operator wants new
angles and has only ever used the mode designed to copy. Untested in production.

### 3.4 CTA style match
Instruction currently reads *"stack them, never trade"*, so every close recites
the full offer block: "90 day" in 40/43 briefs, the guarantee in 33/43. Match
the source's close in length and register; carry only the facts it has room for.

### 3.5 Known bug, introduced 2026-08-13
The distinctness axis fights the architecture rule: framed-list hooks are
SUPPOSED to be alike, the gate flags HOOKS_ALIKE, the rewrite fires and drifts
the frame — which is how "Three reasons why you **shouldn't**…" became "Three
reasons this is replacing surgery", losing the reverse psychology that IS the
ad. Fix: skip distinctness for FRAMED_LIST/REVERSAL; forbid the rewrite from
altering the frame's signature words.

---

## Layer 4 — operational debt

- **JWT_ACCESS_SECRET / JWT_REFRESH_SECRET unset on Puure** — sessions signed
  with hardcoded fallbacks. Security, not cosmetics.
- **Credential rotation** — a Cloudflare API token and both R2 keys were pasted
  into a chat transcript and are still live.
- **~50 env vars absent on Puure** — Frame.io, Meta, Slack, statics lists. Each
  is a feature that silently does nothing until first use.
- **Fork separation** — one repo, one Cloudflare account, one ClickUp workspace,
  shared LLM keys. All must split before the Mineblock sale.
- **B/C tier badge** reads 0 while the filter correctly returns 24.

---

## Sequencing

| Phase | Work | Buys |
|---|---|---|
| **0** | 3.5 bug, JWT secrets, rotation | stops active harm |
| **1** | 1.1 harness, 1.2 self-check | every later change becomes safe and fast |
| **2** | 3.1 angle exclusions, 3.4 CTA, 3.2 diversity | fixes the sameness |
| **3** | 3.3 iterate mode trial | possibly the real answer to "new angles" |
| **4** | 2.1 feedback loop, then 2.2 | the tool starts improving on its own |
| **5** | Autopilot triage pass on real outcomes | strategist, not scheduler |

**Phase 1 is the one that changes the trajectory.** Everything shipped tonight
was verified by hand, which is why three regressions happened and why each cost
a manual cycle to find. With the harness, phases 2-5 move several times faster
and stop reintroducing old defects.

**Phase 4 is what makes it a $100M-company tool** rather than a good internal
script generator. Until outcomes flow back, every quality judgement — including
every one made this week — is a proxy.
