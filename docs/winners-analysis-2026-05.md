# Winning Ads Analysis + Iteration Plan
_Generated 2026-05-11 · MinerForge Pro (Mineblock LLC) · Facebook Ads_

## Data Sources & Caveats

- **Performance** — Triple Whale `pixel_joined_tvf`, attribution `lastPlatformClick`, date range **2026-04-01 → 2026-05-09**.
- **Briefs** — ClickUp list `Video Ads` (`901518716584`). Custom-field lookup by `Brief Number`. Fallback was team-wide search.
- **Missing briefs.** `B0108` and `B0112` are **NOT in the current ClickUp Video Ads list**, archived sections, or any sibling Creatives list. Custom-field filter and team-wide name search both returned zero matches. These briefs predate the current ClickUp setup (both launched WK10_2026 / week of March 2 2026) and are likely archived or were authored in the previous workflow. For these two, the brief reconstruction below is built **only from the decoded ad name + observed performance**, and is explicitly marked as such.
- **Format slot conflict.** Ad-name parser shows `B0131-H3` as `Shortvid`, but the brief's custom fields and the referenced Frame.io file indicate `Mashup`. Treating it as **Mashup**; the slot is a labeling drift, not a creative drift.
- **B0216 + B0207 are weaker winners than the rest.** Per the brief set you gave, both are on the list, but in the 2026-04-01 → 2026-05-09 window B0216-H1 = ROAS 0.59 ($489 spend) and B0207-H1 = ROAS 1.21 ($277 spend). Either they hit earlier and have since fallen, or the call was made on a tighter date range. Flagging them but still extracting them in full.

---

## Brief Extracts

### B0112 — H2 (winner)

- **Status** — Missing from ClickUp current list. Reconstructed from ad name + script signals visible in B0138 (which uses `B0112` as `Parent Brief ID`).
- **Ad name** — `MR - B0112 - H2 - NN - NA - Apology - MoneySeeker - Lottery - Mashup - Ludovico - NA - Antoni - WK10_2026`
- **Performance (Apr 1 – May 9)** — $10,383 spend / $21,937 rev / **ROAS 2.11** / 146 purchases. The "Copy" duplicate did another $8,833 / $18,419 / **ROAS 2.09** / 95 purchases. Combined ≈ **$19,216 spend at ROAS 2.10** — the single biggest ad in the account by spend and by absolute profit contribution.
- **Avatar** — MoneySeeker (someone chasing a low-cost path to an outsized payout; not technical, sees the device as a lottery ticket).
- **Angle** — Lottery ("you get N daily shots at the full block reward").
- **Mechanism (slot)** — Apology. The script device is a founder-style apology / mea-culpa framing.
- **Format** — Mashup (screen-recording + green-screened presenter overlay + chart cuts).
- **Reconstructed hook (H2)** — based on the surviving Italian translation `B0138-H1` from the same lineage, the H2 hook is the founder-style "I have to apologize. We sold this for too cheap / kept this too quiet — and here's the correction" beat. The body is the standard MinerForge proof stack (block reward $300K, 144 daily attempts, blockchain-verifiable, 1¢ electricity, 60-second setup, 90-day guarantee).
- **Beliefs / desires / pain pre-ad** — _I'm tired of regular crypto plays that go nowhere. I missed BTC once. I want a small, asymmetric bet — not another monthly fee or scammy app._
- **Source of pain** — feeling priced out of crypto; mistrust of past mining ads as scams.

### B0108 — HX (winner)

- **Status** — Missing from ClickUp current list. Reconstructed from ad name + child brief `B0231` (which uses `B0108` as parent).
- **Ad name** — `MR - B0108 - HX - NN - NA - Cartoon - MoneySeeker - Lottery - Mashup - Ludovico - NA - Antoni - WK10_2026`
- **Performance** — $7,419 / $12,939 / **ROAS 1.74** / 103 purchases. Second-largest ad in the account.
- **Avatar / Angle** — MoneySeeker / Lottery (same as B0112).
- **Mechanism (slot)** — Cartoon. The "HX" hook designation implies the variant is an animated / cartoon-style opening rather than a numbered live-action hook.
- **Format** — Mashup, but with a cartoon insert (likely an explainer animation of the device + 144 daily attempts cycle, then live-action proof).
- **Editor** — Antoni — same hand as B0112. Antoni-cut is the heaviest-spend pattern in the account.
- **HX hook variant clarification** — `HX` is the convention this team has been using for **non-numbered / one-off variants** (cartoon, voice-over only, alternate framing). It is **not** a different script — it's the same body, opened with a fully different stylistic device. **Recommend confirming HX = the cartoon opener.** If a clearer definition exists, fill it in here.

### B0142 — H3 (winner)

- **Task** — [clickup/86c92m6f8](https://app.clickup.com/t/86c92m6f8) — _MR - B0142 - IT - B0071 - NA - Againstcompetition - Mashup - Ludovico - NA - Uly - WK15_2026_
- **Performance** — $5,848 / $12,935 / **ROAS 2.21** / 76 purchases. Third-largest ad. (H4 of the same brief: $946 / $1,256 / 1.33.)
- **Avatar** — Brief slot is `NA`. The script speaks from the founder's voice (James), not from a buyer persona.
- **Angle** — Against competitors (parent brief `B0071`).
- **Mechanism** — Founder-rebranding announcement: _"we're killing our bestselling device, and it's going to make a lot of people angry."_
- **Format** — Mashup.
- **H3 (exact line, from brief)** — _"I'm the founder of Miner Forge Pro and I'm about to make an announcement that changes everything."_
- **Body summary** — The "knockoff artists flooded the market → we built 2.0 → here's what changed → blockchain-verifiable vs fake animated screens → 62% off + code 2026 + first 1,000 only + 90-day guarantee." Heavy on the **proof-vs-fakes** beat: animated knockoff screens (zero on-chain) vs. real on-chain attempts.
- **Beliefs / desires / pain pre-ad** — _I've seen one of those fake animated mining gadgets before. I don't want to get scammed. If it's real, prove it._
- **Source of pain** — fear of being the sucker; loss of trust in the BTC-mining-gadget category.

### B0131 — H3 (winner)

- **Task** — [clickup/86c8n6d6a](https://app.clickup.com/t/86c8n6d6a) — _MR - B0131 - IT - B0017 - Cryptoaddict - Lottery - Mashup - Ludovico - NA - Muhammad - WK12_2026_
- **Performance** — $2,230 / $4,151 / **ROAS 1.86** / 17 purchases.
- **Avatar** — Cryptoaddict.
- **Angle** — Lottery (parent `B0017`).
- **Mechanism** — comedic-dismissal-and-correction. The hook is a hater quote dismissing the product, the body is the founder's wordless on-screen reaction with the proof.
- **Format** — Mashup, fast-cut, scored to the song the brief links (YouTube `w-sQRS-Lc9k` from 0:12, "multiple fast clips").
- **H3 (exact)** — _"Nobody wins those 😂"_
- **Body (exact, from brief)** — _"Me:"_ — followed by a wordless show-don't-tell sequence of the device working + the on-chain mining attempts. **The brief leaves it deliberately short.** Voice does not over-explain.
- **Beliefs / desires / pain pre-ad** — _I've heard this pitch before. It's another mining scam. Anyone telling me otherwise is naïve._
- **Source of pain** — being mocked for falling for one of these in the past.

### B0224 — H3 (winner)

- **Task** — [clickup/86c9eu60f](https://app.clickup.com/t/86c9eu60f) — _MR - B0224 - NN - NA - Cryptoaddict - Lottery - Mashup - Ludovico - NA - Uly - WK17_2026_
- **Performance** — $564 / $1,158 / **ROAS 2.05** / 5 purchases.
- **Avatar** — Cryptoaddict.
- **Angle** — Lottery, but routed through the **mythbusting** mechanism (skeptic verifies on-chain).
- **Mechanism** — "I thought this was a scam, then I opened Block Explorer."
- **H3 (exact, from brief)** — _"Everyone told me it was too good to be true. So I went straight to the blockchain to find out. This is MinerForge Pro. It competes for full Bitcoin blocks worth around $300,000."_
- **Body (exact)** — Pulls up specific block numbers (91,612 / 92,618) solo-mined four hours ago, three hours ago. _"These are not coming from industrial warehouses. These are coming from small devices exactly like this one. Sitting on a desk somewhere. Running quietly on 11 cents a month."_ Closes with: 58% off + free shipping + _"Proof is on the blockchain. Your call."_
- **Beliefs / desires / pain pre-ad** — _I want to be sold the truth, not the dream. Show me the data._
- **Source of pain** — being lied to by previous crypto products; wanting verifiable, public truth.

### B0230 — H2 (winner)

- **Task** — [clickup/86c9f220n](https://app.clickup.com/t/86c9f220n) — _MR - B0230 - NN - NA - Cryptoaddict - Lottery - Cartoon - Ludovico - NA - Jerome - WK17_2026_
- **Performance** — $752 / $1,522 / **ROAS 2.02** / 7 purchases. (H1 only got $93 spend, ROAS 4.60 / 2 purch — small but very efficient. H3 $452 / $0 — broken.)
- **Avatar** — Cryptoaddict.
- **Angle** — Lottery.
- **Mechanism** — **First-person AI-chip POV.** The chip itself narrates. ("I am solo mining. I am one watt of power. I am the 90-day guarantee.")
- **Format** — Cartoon (animated chip + product cut-aways).
- **H2 (exact, from brief)** — _"Most people plug in MinerForge Pro and let it run. But very few know what is actually happening inside it. Let me show you."_
- **Body (exact, abbreviated)** — _"I am an AI chip. I power every solo mining attempt MinerForge Pro fires at the Bitcoin network. 144 times a day. Automatically. Without you lifting a finger… I am one watt of power. I cost 11 cents a month to run. Less than a nightlight. Less than a coffee. Running around the clock competing for $300,000… And I am the 90 day guarantee. Try MinerForge Pro risk free. Together we do not just give you a shot at $300,000. We give you 144 shots. Every single day. Forever."_
- **Beliefs / desires / pain pre-ad** — _I want to understand what's actually inside the box before I buy. I'm skeptical of mining gadgets that just show a flashing LCD._
- **Source of pain** — being treated as too dumb to be told how the device works; black-box mining products.

### B0216 — H1 / H2 / H3 (called "winner" but currently underperforming in our window)

- **Task** — [clickup/86c9d803w](https://app.clickup.com/t/86c9d803w) — _MR - B0216 - NN - NA - Cryptoaddict - BTC Made easy - Mashup - Roman - NA - Sonny - WK17_2026_
- **Performance (Apr 1 – May 9)** — H1 $489 / $290 / **ROAS 0.59** / 2 purch. H2 $57 / $0. H3 $14 / $162 / 11.49 (sample size 1). **None of the hooks are clearing breakeven in this window.**
- **Avatar** — Cryptoaddict.
- **Angle** — "BTC Made easy" — but the script's actual angle is **stack-volume / multi-device math** (1 device = 144 attempts → 8 devices = 1,152 attempts → bigger bundle = more shots).
- **Mechanism** — visual math: numbers morph on screen + product stack hero shot.
- **Strategist** — Roman (not Ludovico). Editor — Sonny (not Antoni / Uly / Muhammad / Jerome). This is the **only ad on the "winner" list whose strategist + editor pair is entirely outside the proven crew.**
- **Hooks (exact, from brief)**:
  - **H1** — _"People always ask why I have 8 of these little screens running on my desk."_
  - **H2** — _"Buying 1 of these is cool. But running a stack of them is the actual strategy."_
  - **H3** — _"Here is the simple math behind why serious hobbyists run multiple devices at 1 time."_
- **Body (exact, from brief)** — 1 MinerForge Pro 2.0 = 144 daily attempts. _"But I am running 8 of them. That means my setup makes over 1100 attempts every single day. And because they only draw 1 watt of power my entire stack costs less than $10 a year in electricity."_ Closes with Buy-6-Get-2-Free + `MINER10` 10% off.
- **Beliefs / desires / pain pre-ad** — _If a $60 box gives me 144 shots, what if I owned 8?_ — the upsell-to-bundle logic.
- **Why it's not hitting (hypothesis)** — the "buy 8" frame **collapses the lottery emotion** ("free shot at $300K") into a hard-math AOV-stretch ask. It moves the buyer from "what's the worst that could happen?" mindset to "wait, am I spending $400+ on a stack?" The angle is too AOV-driven and too narrow (returning customer / Cryptoaddict hobbyist). **Recommend treating B0216 as a working bundle-upsell concept that needs a different audience (retargeting), not a cold-traffic winner.**

### B0207 — H1 (called "winner" but borderline)

- **Task** — [clickup/86c9btaah](https://app.clickup.com/t/86c9btaah) — _MR - B0207 - NN - NA - Cryptoaddict - Missedopportunity - Mashup - Ludovico - NA - Muhammad - WK16_2026_
- **Performance (Apr 1 – May 9)** — H1 $277 / $335 / **ROAS 1.21** / 3. H2 $217 / $180 / 0.83. H3 $91 / $0.
- **Avatar** — Cryptoaddict.
- **Angle** — Missedopportunity — _"They told you it was over. It's not."_
- **Mechanism** — historical reframe ("for a decade you needed a pool / now solo mining is back").
- **Format** — Mashup.
- **H1 (exact)** — _"Has Bitcoin mining become impossible for people with a small budget? That is what they want you to believe."_
- **Body (abbreviated)** — Tells the "you got priced out of mining by warehouses, then a chip-efficiency breakthrough brought it back / no pools / full block reward $300K / 1 watt / 60-second setup / stock is kept limited because too many active miners affects everyone's odds." Closes with 58% off + free shipping.
- **Beliefs / desires / pain pre-ad** — _I gave up on mining years ago. The little guy can't compete._
- **Source of pain** — feeling the BTC opportunity has permanently passed them by; that they're "too late."

---

## Cross-Winner Pattern Analysis

### Avatar — Cryptoaddict dominates the recent winners, MoneySeeker dominates the older heavy-spend winners

| Brief | Avatar (per ad name) |
|---|---|
| B0108-HX, B0112-H2 | **MoneySeeker** (WK10 launches — the two biggest spenders) |
| B0131-H3, B0207-H1, B0216, B0224-H3, B0230-H2 | **Cryptoaddict** (WK12–WK17) |
| B0142-H3 | NA (founder-voice, no buyer persona) |

This is **not "MoneySeeker is the dominant winner."** It's "the two MoneySeeker ads we have hit early (WK10) and have been scaled hard since, and **every newer attempt to scale MoneySeeker has failed**" (B0202, B0212, B0222, B0242, B0258, B0263 all MoneySeeker, all sub-1.5 ROAS). The **avatar that's still working at the time of writing is Cryptoaddict**.

### Angle — Lottery is the lock

7 of 8 winners use **Lottery** ("$300K block, 144 daily shots, blockchain-verifiable") or **Lottery-via-mythbusting** (B0224 — "I thought this was a scam, then I checked the chain"). The only non-Lottery winners are:
- **B0142 — Againstcompetition** (founder-rebrand-anti-knockoff)
- **B0207 — Missedopportunity** (you-were-told-it-was-over)
- **B0216 — BTC-Made-easy / stack-math** (and it's the one underperforming in the window)

The Lottery framing converts because the entire product proposition is itself a lottery: low cost, asymmetric upside, verifiable mechanism.

### Mechanism / proof device — every winner has a verifier

The unifying device across winners is **on-chain proof** that the device is doing what it claims. The strongest variants make the verifier explicit:
- **B0224** opens Block Explorer on screen, calls out specific block numbers ("Block 91,612 — solo mined four hours ago").
- **B0142** contrasts "fake miners' animated screens" with "real on-chain attempts you can verify yourself."
- **B0230** personifies the chip and itemizes what each operation is ("I am blockchain verification. Every attempt I submit is real. Recorded. Public.")
- **B0112 / B0108** (per the lineage) — Apology + Cartoon are both vehicles for the same proof beat.

### Format — Mashup is the format

7 of 8 winners are **Mashup** (the format that interleaves screen recordings + on-chain footage + green-screened presenter overlay). The single Cartoon (B0230) works because the cartoon **is the proof device** — the AI chip narrating itself. No winning ShortVid in the recent window. No winning UGC at scale in the recent window.

### Hook position — no clear position predictor

H2 (×2), H3 (×3), H1 (×1), HX (×1). The hook position **isn't predictive**; the hook **content** is. The thing every winning hook does:
- **Names a buyer's pre-existing belief** ("Nobody wins those," "I thought this was fake too," "Has BTC mining become impossible?", "Why I have 8 of these on my desk")
- **Or names an insider's secret** ("Let me show you what's actually happening inside it," "I'm about to make an announcement that changes everything")

Hooks that pitch the product directly ("Did you know you can compete for $300K daily?" — B0230-H1) under-spend or fail.

### Editor — Antoni's cuts dominate by spend, but four editors are producing winners

| Editor | Winners | Combined spend |
|---|---|---|
| **Antoni** | B0112-H2 (+Copy), B0108-HX | ~$26.6K — by far the heaviest |
| **Uly** | B0142-H3, B0224-H3 | ~$6.4K |
| **Muhammad** | B0131-H3, B0207-H1 | ~$2.5K |
| **Jerome** | B0230-H2 | $752 |
| **Sonny** | B0216 (only "winner" not actually winning right now) | — |

Antoni is the only editor cutting at WK10-scale spend. **All new launches in WK17+ that fail are from editors who don't appear in the winners list (DIMARANAN, Fazlul, Elizaveta, Sergei).** Roman-as-strategist + non-Antoni-editor is the new-launches-failing pattern.

### Common script structure across all winners

Every winning script follows roughly this 7-beat structure:
1. **Hook** — name a buyer belief or a hidden insider truth (don't pitch the product).
2. **Stakes** — $300K block reward.
3. **Frequency** — 144 attempts per day, automatically.
4. **Proof** — on-chain / blockchain-verifiable (the differentiator from "fake animated miners").
5. **Cost** — 11¢/month or $1/year electricity. **Sets the bet as asymmetric: cost almost nothing, win life-changing money.**
6. **Setup** — 60-second plug-and-play.
7. **Risk-reversal** — 90-day money-back + 58% off + sometimes a `MINER10` extra-10% code.

Removing any of beats 4 / 5 / 7 is the most common failure mode in losing ads.

---

## Why It's Working

The audience already believes three things before the ad starts:
- **They missed Bitcoin once** — they wish they'd bought in early; they don't want to miss again.
- **Mining is for industrial warehouses now** — they've been told they're priced out.
- **Most BTC-mining gadgets are scams** — the category has spent the last few years burning trust with display-only fakes.

The winning ads confirm belief #1 and belief #2 ("yes, you were priced out, here's why"), then **break belief #3 with a falsifiable proof mechanism** (the blockchain). The redirect is: _"This is the smallest possible bet on the biggest possible payoff, and you can verify it yourself before you trust me."_ The buyer is allowed to keep being a skeptic — that's a feature, not a bug, of the conversion path.

The price + warranty stack converts because the bet is genuinely asymmetric in dollar terms: **$60 (or $25 after stack discount) of capital and ~$1/year of electricity to play a $300K lottery 144 times a day.** Even buyers who think they'll never win can rationalize it as worth-the-cost-of-finding-out.

The **Mashup format works because the entire script is a fact-claim sequence** that wants to be backed by overlaid visuals (block-explorer screen, electricity meter, setup steps, on-chain transaction). A ShortVid or UGC format strips away the visual proof, which is why those formats keep failing on this same product.

The **Cryptoaddict avatar is the right audience right now** because:
- They already have a wallet.
- They already speak the lexicon ("block reward," "solo mining," "blockchain") — no education tax.
- They scroll past generic offers; only proof + verifiable mechanism stops them.

MoneySeeker still works in the legacy WK10 cuts (B0108 / B0112) because those ads happen to use an Apology / Cartoon mechanism that **doesn't depend on the viewer being crypto-literate** — they explain the device. But every NEW MoneySeeker attempt (B0202, B0212, B0222, B0242, B0258, B0263) has had a different mechanism — and none of them have the same Apology / Cartoon device-explainer structure. The avatar isn't the problem in those failures; the mechanism is.

---

## Why New Launches Are Failing (Hypothesis)

Looking at the recent losing ads (spend ≥ $100, ROAS < 1.6, last ~5 weeks), three drifts explain most of the misses:

### Drift 1 — Format drift: Mashup → ShortVid

Every winning ad except B0230 is a Mashup. **9 of the top 20 fails are ShortVid** (B0067, B0190, B0222, B0236, B0239, B0242, B0251, B0253, B0258, B0263). ShortVid strips the on-chain proof overlay — which **is** the conversion mechanism. The product is verifiable; if you don't show the verification, you lose.

### Drift 2 — Strategist drift: Ludovico → Roman

Ludovico is the strategist on 7 of 8 winners. **Roman has become the strategist on a wave of newer briefs** (B0186, B0211, B0212, B0220, B0236, B0239, B0251, B0253, B0258, B0263, B0216) and **almost none of them are clearing 1.5 ROAS**. The most likely cause isn't Roman per se — it's that the team has been pumping out *more* briefs by adding a second strategist, and the new briefs don't include the proven 7-beat structure (Hook→Stakes→Frequency→Proof→Cost→Setup→Risk-reversal). They lean on lifestyle hooks ("People ask why I have 8 of these…") that skip the proof beat.

### Drift 3 — Editor drift: Antoni / Uly / Muhammad → DIMARANAN / Fazlul / Elizaveta / Sergei

Every recent losing ad ≥ $300 spend at ROAS < 0.8 is cut by an editor who **does not appear** in the winners list. The 4 working editors (Antoni, Uly, Muhammad, Jerome) all share a fast-cut Mashup rhythm with on-screen text overlays synced to claims. The newer editors are doing slower paced ShortVid cuts that don't match the format that converts.

### Drift 4 — Avatar drift back to MoneySeeker without the matching mechanism

MoneySeeker only wins paired with **Apology** (B0112) or **Cartoon** (B0108) — both of which explain the device first. Newer MoneySeeker ads (B0202 Lottery-Mashup, B0212 Lottery-Mashup, B0222 Lottery-ShortVid, B0242 Againstcompetition-ShortVid, B0258 ASMR-ShortVid, B0263 Missedopportunity-ShortVid) **drop the explainer mechanism**. Result: ROAS 0.5–1.4 across all of them.

### Drift 5 — Hook drift away from belief-naming

The recent ad hooks pitch the product directly ("MR - B0067 - shortvideo against competitors," "MR - B0220 - Cryptoaddict - Against," "MR - B0263 - Missedopportunity"). The winners **never** pitch the product first. They name a viewer belief, then redirect.

---

## Iteration Plan

For each winning brief, **3–5 concrete iterations**. Iterations are tagged:
- **(a) Same script, new opener** — cheapest test
- **(b) Same hook, new visual mechanism** — moderate cost
- **(c) Same angle, new avatar** — moderate cost
- **(d) Cross-pollinate** — winning mechanism from one brief onto another

Each iteration: **hook line (verbatim), opening visual (1–2 sentences), mechanism, expected variable.**

### Iterations off B0112 (MoneySeeker-Apology-Mashup, ROAS 2.11, biggest spender)

1. **(a) Same-script + Sora-style social-proof open**
   - **Hook:** _"I told everyone this device was a scam. Then I checked the block I solo-mined yesterday."_
   - **Opening visual:** Top-down phone-on-desk shot showing Block Explorer URL pulled up; the user's wallet receives a partial reward animation; cut to MinerForge plugged in next to a coffee cup.
   - **Mechanism:** Apology (self) — flips the founder-apology into a buyer-apology.
   - **Expected variable:** Whether the apology emotion works framed from the buyer rather than the founder.

2. **(a) Same-script + price-shock open**
   - **Hook:** _"I bought a Bitcoin miner for $1.32. That's how much it costs to run for a year."_
   - **Opening visual:** A $1.32 receipt printed from a kitchen-sink electricity bill, then the camera pans up to the device.
   - **Mechanism:** Apology (founder) — same body.
   - **Expected variable:** Whether the cost-asymmetry framing beats the founder-confession opener.

3. **(b) Apology mechanism but as Cartoon**
   - **Hook:** _"I'm the chip that no one was supposed to see."_
   - **Opening visual:** 2D animated semiconductor chip turns toward camera; speaks in first person (Pixar-style); the rest of the cartoon is the B0112 body delivered by the chip.
   - **Mechanism:** Cartoon (steal from B0230) on the B0112 script.
   - **Expected variable:** Whether the Cartoon visual mechanism scales the Apology script the way it scaled the Lottery script on B0230.

4. **(c) Same Apology angle, Cryptoaddict avatar**
   - **Hook:** _"To everyone holding BTC: I owe you an apology. We've been letting you mine wrong."_
   - **Opening visual:** founder-on-camera, no graphics, talking-head intro for 3 seconds before the screen cuts to the proof stack.
   - **Mechanism:** Apology, retargeted to crypto-native audience.
   - **Expected variable:** Whether Apology works on a non-MoneySeeker avatar (we've only seen it work on MoneySeeker so far).

5. **(d) Apology mechanism + B0224 Block Explorer body**
   - **Hook:** _"Most miners are lying to you. I'm going to apologize for the entire category and prove what's real."_
   - **Opening visual:** founder pulls up Block Explorer mid-speech and scrolls to a recent solo-mined block; cuts the rest of the apology around B0224's body.
   - **Mechanism:** Apology framing on B0224's mythbust-with-on-chain body.
   - **Expected variable:** Whether stacking the two strongest mechanisms (Apology + on-chain mythbust) compounds or cannibalizes.

### Iterations off B0108 (MoneySeeker-Cartoon-Mashup, HX, ROAS 1.74)

1. **(a) Same-cartoon-script + lottery-ticket opener**
   - **Hook:** _"This little chip has more chances of winning $300,000 today than you have of winning the Powerball this year."_
   - **Opening visual:** Side-by-side animated lottery ticket vs. MinerForge device; numbers tick up on MinerForge side ("144 / day") while lottery ticket ticks once.
   - **Mechanism:** Cartoon (same), Lottery (same), but visualized as actual lottery comparison.
   - **Expected variable:** Whether explicit lottery-vs-lottery framing outperforms the current cartoon intro.

2. **(b) Same hook, Mashup-only (no cartoon insert)**
   - **Hook:** (B0108 HX cartoon line — TBD pending confirmation of what HX actually says.)
   - **Opening visual:** Same hook delivered by a real person on a real desk with a real Block Explorer pulled up, no animation.
   - **Mechanism:** drop cartoon, keep Mashup.
   - **Expected variable:** How much of B0108's lift is the cartoon vs. the underlying script.

3. **(c) Same Cartoon mechanism, Cryptoaddict avatar (TikTok-native voice)**
   - **Hook:** _"POV: your portfolio is down 30%, but your $60 chip just mined block 92,500."_
   - **Opening visual:** Split-screen animated chart crashing on left, mining-attempt counter ticking up on right; portfolio recovers in the closing seconds.
   - **Mechanism:** Cartoon + Cryptoaddict-coded copy.
   - **Expected variable:** Whether Cartoon survives an avatar swap.

4. **(d) Cartoon mechanism on B0142's anti-knockoff angle**
   - **Hook:** _"This is what real Bitcoin mining looks like. Everything else is just animation."_
   - **Opening visual:** Cartoon-animated "fake miner" with a blinking LCD, then the cartoon screen shatters and a real device fills the frame; on-chain proof overlay follows.
   - **Mechanism:** Cartoon proof-of-real device.
   - **Expected variable:** Whether the proof-vs-fakes message (B0142) lands harder when the fake **is** the cartoon.

### Iterations off B0142 (Founder-anti-knockoff-Mashup, H3, ROAS 2.21)

1. **(a) Same-script + harder anti-fakes hook**
   - **Hook:** _"There are now nine fake versions of our miner on Facebook. Here's how to spot the real one."_
   - **Opening visual:** Founder holds the real device; cut to a 3×3 grid of competitor product photos; one by one each grid cell is X'd out with on-chain proof failure.
   - **Mechanism:** anti-knockoff (same).
   - **Expected variable:** Whether explicit competitor call-out converts harder than founder-confession.

2. **(a) Same-script + first-person buyer-skeptic open**
   - **Hook:** _"I almost bought a fake one. Here's how I caught it."_
   - **Opening visual:** Buyer (not founder) on phone, scrolling Facebook ads, hovering over a competitor ad, then opening Block Explorer.
   - **Mechanism:** Same anti-knockoff body, voiced by a buyer not a founder.
   - **Expected variable:** Whether buyer-skeptic POV out-converts founder-mea-culpa.

3. **(b) Same H3 hook, no founder face**
   - **Hook:** _"I'm the founder of Miner Forge Pro and I'm about to make an announcement that changes everything."_
   - **Opening visual:** Voice-only over a B-roll of the new device in low-key lighting, no founder face; then on-chain proof reel.
   - **Mechanism:** Mashup, no talking head.
   - **Expected variable:** Whether the founder face is doing the work, or whether the founder voice is enough.

4. **(c) Same anti-competitor angle, Cryptoaddict-skeptic avatar**
   - **Hook:** _"I run two mining pools. I told my followers not to buy this. I was wrong."_
   - **Opening visual:** A pseudo-influencer-style intro from a "crypto channel" persona admitting they were wrong; cuts to B0142 body.
   - **Mechanism:** anti-knockoff via reverse-influencer.
   - **Expected variable:** Whether reverse-endorsement converts a Cryptoaddict audience harder than founder testimony.

5. **(d) B0142 anti-knockoff body + B0224 Block Explorer mythbust**
   - **Hook:** _"Every fake miner shows a screen. The real one shows up on the blockchain."_
   - **Opening visual:** Three competitor ads playing side-by-side; on the fourth tile, screen recording opens Block Explorer and pulls a recent solo-mined block.
   - **Mechanism:** B0224 mythbust on B0142's knockoff frame.
   - **Expected variable:** Whether stacking proof devices breaks past the ROAS 2.2 ceiling of either alone.

### Iterations off B0131 (Cryptoaddict-Lottery-Mashup, H3 "Nobody wins those 😂", ROAS 1.86)

1. **(a) Same-script + new hater-quote hook variants**
   - **Hook:** _"This is the dumbest thing I've ever seen on this app. 😂"_
   - **Opening visual:** screenshot of the hater comment, then cut to the founder's silent on-screen reaction (same wordless body as the original).
   - **Mechanism:** comedic-dismissal + wordless show-don't-tell.
   - **Expected variable:** Whether a stronger hater-quote raises CTR without breaking the comedic landing.

2. **(a) Same-script + condescending-expert hook**
   - **Hook:** _"Funny how the 'experts' on Twitter all sound the same when they're wrong."_
   - **Opening visual:** Side-by-side three crypto-twitter avatars saying the same dismissive line; product cuts to Block Explorer.
   - **Mechanism:** comedic-dismissal-of-authority.
   - **Expected variable:** Whether dismissing experts beats dismissing strangers.

3. **(b) Same hook, ShortVid skit format**
   - **Hook:** _"Nobody wins those 😂"_
   - **Opening visual:** Hater-character on camera says the line; founder character holds up the device, doesn't reply, cuts to a 5-second on-chain proof.
   - **Mechanism:** sketch-comedy variant of the same wordless body.
   - **Expected variable:** Whether the joke needs a Mashup wrapper or just lands as a skit.

4. **(c) Same comedic angle, MoneySeeker avatar**
   - **Hook:** _"My broker said this was a waste of $60. So I waited 30 days."_
   - **Opening visual:** Buyer on-camera with the device, smug; cut to a 30-day timer; cut to a Block Explorer hit on day 27 (illustrative — not promising a real win).
   - **Mechanism:** dismissal + delayed-proof.
   - **Expected variable:** Whether the comedic frame survives an avatar swap.

5. **(d) B0131 hook + B0230 AI-chip body**
   - **Hook:** _"Nobody wins those 😂"_
   - **Opening visual:** The hater quote fades; the AI chip (animated) appears and says _"Let me introduce myself."_; rest is B0230's first-person body.
   - **Mechanism:** dismissal-flip into AI-chip POV.
   - **Expected variable:** Whether the comedic-dismissal hook into a serious-proof body compounds.

### Iterations off B0224 (Cryptoaddict-Lottery-Mashup, H3 mythbust, ROAS 2.05)

1. **(a) Same script + reverse-skeptic hook**
   - **Hook:** _"My wife told me I got scammed. So I pulled up the blockchain to prove her wrong."_
   - **Opening visual:** Buyer on couch holding the device, wife in background skeptical; cut to laptop with Block Explorer.
   - **Mechanism:** mythbust + relatable household tension.
   - **Expected variable:** Whether adding interpersonal stakes lifts the verification CTR.

2. **(a) Same script + reporter-style hook**
   - **Hook:** _"This is the most controversial Bitcoin product on Facebook right now. So I went on-chain to settle it."_
   - **Opening visual:** Tabloid-style overlay with the product in the headline; cut to Block Explorer.
   - **Mechanism:** mythbust + news-frame.
   - **Expected variable:** Whether a news-frame raises trust over personal-skeptic frame.

3. **(b) Same hook, ShortVid mythbust**
   - **Hook:** _"Everyone told me it was too good to be true. So I went straight to the blockchain to find out."_
   - **Opening visual:** Vertical 9:16, locked-off phone-shot, the buyer pulls up Block Explorer on a second phone; no Mashup overlays.
   - **Mechanism:** Mythbust delivered as bedroom UGC.
   - **Expected variable:** Whether the body proofs alone are enough without Mashup overlays.

4. **(c) Same mythbust angle, MoneySeeker avatar with cost frame**
   - **Hook:** _"$60 for 144 chances at $300,000? I called bullshit. Then I checked the chain."_
   - **Opening visual:** Math overlay (60 ÷ 300000) reading "0.02%"; cut to Block Explorer.
   - **Mechanism:** mythbust + asymmetric-bet framing.
   - **Expected variable:** Whether explicit math + mythbust beats mythbust alone.

5. **(d) B0224 mythbust mechanism + B0142 anti-knockoff body**
   - **Hook:** _"All those fake miners on Facebook? I pulled up the blockchain on every single one."_
   - **Opening visual:** Three ad screenshots; opens Block Explorer for each; the first two show zero on-chain activity; the third (MinerForge) shows a recent block.
   - **Mechanism:** mythbust applied to the knockoff narrative.
   - **Expected variable:** Whether direct competitor falsification beats founder testimony.

### Iterations off B0230 (Cryptoaddict-Lottery-Cartoon, H2 AI-chip POV, ROAS 2.02)

1. **(a) Same script + curiosity-gap hook**
   - **Hook:** _"Inside every MinerForge there's a chip that's been awake longer than you've been alive."_
   - **Opening visual:** Tight macro shot of the chip; subtle clock-tick sound; cuts into the AI-chip POV cartoon.
   - **Mechanism:** Cartoon first-person, harder curiosity-gap.
   - **Expected variable:** Whether a more dramatic curiosity hook raises 3-sec retention vs. the original calm hook.

2. **(a) Same script + "what's inside" hook**
   - **Hook:** _"This is the only Bitcoin product where every internal part has a public job."_
   - **Opening visual:** Exploded-view of the device with labels appearing on each part.
   - **Mechanism:** Cartoon + product transparency.
   - **Expected variable:** Whether a transparency frame beats a personification frame.

3. **(b) Same script, live-action format**
   - **Hook:** _"Most people plug in MinerForge Pro and let it run. But very few know what is actually happening inside it. Let me show you."_
   - **Opening visual:** Founder on camera at desk; opens up the device case to show the chip; voiceover delivers the same B0230 body.
   - **Mechanism:** drop cartoon; keep first-person device-explainer body.
   - **Expected variable:** Whether the cartoon is doing the work or the body.

4. **(c) Same Cartoon mechanism, Founder-avatar (B0142 angle)**
   - **Hook:** _"This is the device we built. Let me tell you what's actually inside it."_
   - **Opening visual:** Cartoon-style intro of the founder, then cartoon-chip narration.
   - **Mechanism:** Cartoon + founder.
   - **Expected variable:** Whether Cartoon + Founder voice can scale into B0142's range.

5. **(d) Cartoon mechanism + B0224 mythbust body**
   - **Hook:** _"I'm an AI chip. I keep getting accused of being fake. So let me show you my receipts."_
   - **Opening visual:** Animated chip; cuts to Block Explorer screen-recording overlays.
   - **Mechanism:** Cartoon + on-chain mythbust.
   - **Expected variable:** Whether the AI-chip POV adds personality to a mythbust body.

### Iterations off B0216 (bundle-volume math) — **treat as retargeting concept, not cold**

B0216 should be moved out of the cold-traffic ad set. The volume-math message ("buy 8 of these") only converts buyers who already understand the product. Recommended iterations:

1. **(a) Same-script reframe for retargeting** — _"You bought 1. Here's why our top customers run 8."_ — show to 30/60-day-window buyers; new opening shot is the buyer's own past order confirmation animated in.
2. **(c) Same angle, MoneySeeker avatar** — _"What 8 of these could mean for your retirement"_ — speculative but cleaner avatar fit for an AOV-stretch ad.
3. **(d) Bundle-math mechanism + B0224 Block Explorer body** — show 8 devices each independently making on-chain attempts in real time on a screen-recording.

### Iterations off B0207 (Missedopportunity, H1) — **treat as borderline, half of these are diagnostic**

1. **(a) Same-script + more concrete pain hook** — _"You've watched Bitcoin go from $1 to $100,000. This is your last cheap entry into mining it."_
2. **(b) Same hook + Cartoon proof body** — drop the historical reframe; replace with B0230's chip-POV.
3. **(c) Same Missedopportunity angle, founder-voice (B0142 mechanism)** — _"I built this for everyone who told me 'I missed it.' I'm trying to make sure you don't miss it twice."_
4. **(d) Missedopportunity mechanism + B0224 on-chain body** — show actual recent solo-mined blocks during the "you didn't miss it, here's proof it's still happening" beat.

---

## Prioritized Next Moves

Ranked by **cost-to-produce vs. expected lift**. Cheap-and-likely first.

### Tier 1 — Ship this week (same-script, new opening hooks — under $0 cost, editor only)

These are pure re-cuts of working scripts with new hook lines and new opening shots. No new shoot, no new product imagery, ~2 hours of editor time each. Lowest production cost, highest expected lift, because all of them inherit a proven body.

1. **B0112-iteration-1** — "I told everyone this device was a scam. Then I checked the block I solo-mined yesterday." Buyer-apology opener over the proven B0112 body.
2. **B0142-iteration-1** — "There are now nine fake versions of our miner on Facebook. Here's how to spot the real one." Harder anti-fakes opener over proven B0142 body.
3. **B0224-iteration-1** — "My wife told me I got scammed. So I pulled up the blockchain to prove her wrong." Interpersonal-stakes opener over proven B0224 body.
4. **B0131-iteration-1** — "This is the dumbest thing I've ever seen on this app. 😂" Harder hater-quote over the wordless body.
5. **B0230-iteration-1** — "Inside every MinerForge there's a chip that's been awake longer than you've been alive." Curiosity-gap opener over proven AI-chip body.

### Tier 2 — Ship within 2 weeks (cross-pollination — moderate effort, highest learning value)

These combine winning mechanisms from different briefs. Higher chance of breaking through the current ROAS ceiling because they stack two proven devices. ~1 day editor time each.

6. **B0224-iteration-5** — B0224 mythbust mechanism + B0142 anti-knockoff body — directly competitor-falsifying with on-chain proof.
7. **B0131-iteration-5** — B0131 dismissal hook into B0230 AI-chip body — comedy-then-serious-proof structure.
8. **B0112-iteration-5** — Apology framing on B0224 mythbust body — most asymmetric "founder owes you the truth" approach.
9. **B0142-iteration-5** — B0142 anti-knockoff body with explicit on-chain falsification of competitor ads.
10. **B0230-iteration-5** — AI-chip POV applied to a mythbust body.

### Tier 3 — Ship within 3-4 weeks (avatar swap — needs new shoot or significantly different copy)

These hold the angle but swap the avatar. They need either a new on-camera person or a noticeable copy rewrite. Worth doing because finding a second working avatar doubles the audience pool. ~1 week each.

11. **B0224-iteration-4** — MoneySeeker avatar on the mythbust angle with explicit math overlay.
12. **B0131-iteration-4** — MoneySeeker avatar on the comedic-dismissal angle.
13. **B0112-iteration-4** — Cryptoaddict avatar on Apology mechanism.
14. **B0142-iteration-3** — pseudo-influencer Cryptoaddict on the anti-competitor angle.
15. **B0230-iteration-3** — drop Cartoon, live-action founder doing the device-explainer body.

### Tier 4 — Format reset experiments (do alongside Tier 1 to diagnose the format question)

The single most expensive recent mistake is the drift from Mashup to ShortVid on working scripts. Two cheap experiments to settle it:

16. **B0224-iteration-3** — Run the B0224 mythbust body as a phone-shot UGC ShortVid. If it converts at >1.6, ShortVid is salvageable on this product; if it doesn't, lock the team to Mashup-only going forward.
17. **B0108-iteration-2** — Drop B0108's Cartoon insert, run the same body as Mashup-only — diagnose how much lift the cartoon device contributes vs. the script.

### Tier 5 — B0216 / B0207 cleanup

18. **Move B0216 to retargeting set** — Stop spending cold-traffic budget on the bundle-math angle. Run it against buyers in the last 30/60 days as an AOV-stretch.
19. **B0207-iteration-1** — Rewrite the H1 hook to name a more visceral missed-opportunity pain (price-anchored), then re-test.

### Tier 6 — Structural fixes to recover the new-launches-failing pattern

Beyond individual ad iterations, three structural moves the strategist + editor team should make immediately:

20. **Lock format to Mashup** on every brief tagged Cryptoaddict-Lottery until further notice. ShortVid + Lottery is currently 0/many in this account.
21. **Reroute new Roman briefs through the proven 7-beat structure** (Hook → Stakes → Frequency → Proof → Cost → Setup → Risk-reversal). Make beat 4 (on-chain proof overlay) mandatory.
22. **Re-pair newer editors (DIMARANAN, Fazlul, Elizaveta, Sergei) with reference edits from Antoni / Uly / Muhammad** before they cut more solo. The win pattern is fast-cut Mashup with text overlays synced to claims — that's a learnable rhythm that the recent cuts are missing.

---
_End of deliverable. Data files: `/tmp/briefs-raw.json`, `/tmp/tw-raw.json`. Fetch scripts: `/tmp/fetch-briefs.mjs`, `/tmp/fetch-tw.mjs`._
