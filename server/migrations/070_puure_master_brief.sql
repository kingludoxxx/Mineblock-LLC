-- Load the full Puure Master Product Brief into product_profiles.master_brief.
-- The distilled profile fields give the Brief Pipeline ~20% of the operator's
-- product document; generation quality requires 100% of it (full angle
-- strategies, mechanism, avatar deep-dive, offer structure).
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS master_brief TEXT;

UPDATE product_profiles
   SET master_brief = $mdbrief$# PUURE™ BREAST LIFT DEVICE — MASTER PRODUCT BRIEF
### Permanent context document for all static & video ad creation

> Built from competitor teardown of **Perki** ("The Restoration Protocol" / "The Restoration Trilogy"):
> 2 long-form advertorial scripts, the advertorial/homepage, and the product page.
> Our locked facts override any competitor specifics.

---

## LOCKED PRODUCT FACTS (our product)
- **Brand:** Puure™ — clean, pure, gentle (reassuring for an intimate body product).
- **Product:** Puure™ Breast Lift Device v1.1 — at-home, non-surgical breast firming & lifting device.
- **Hero tech:** **TriRed™ — Triple Red Light Technology.** THREE red-light wavelengths vs. competitors' single 660nm / dual-spectrum. Our #1 differentiator: *triple beats dual.*
- **Mechanism:** red light penetrates deep (~8mm) → activates fibroblast cells → collagen + elastin synthesis up → firmer, lifted connective tissue over time.
- **Usage:** 10 minutes/day, at home, on your schedule.
- **Positioning:** the smarter, safer, non-surgical alternative to a breast lift — no surgery, no scars, no recovery.
- **Certification:** **FDA approved** — a core credibility and safety proof point (use in ads, PDP, and packaging). *(Confirm "approved" vs "cleared" wording against the clearance/approval paperwork before publishing.)*
- **Price:** **$99 (from $199).** Device only — the oil, cream, gummies, and guide that Perki bundles free are **our upsells**, not in the core offer.
- **Competitors:** Perki (660nm / "dual-spectrum," $99–$149, 90-day guarantee), ReliveX ("Adaptive Correction System"), nooro (perceived-value benchmark).

---

# BRAND & VISUAL IDENTITY
*The locked color + type system for all statics, landing pages, and packaging. (Full guide: Puure-Brand-Blueprint.) Colors adapted from competitor Cavaé; font pulled from the live Puure site (Satoshi).*

**Color palette**

| Role | Name | HEX | Usage |
|---|---|---|---|
| Background | Cream | `#F7EEE7` | Main page background |
| Background (alt) | Soft Cream | `#F9F3EE` | Alternating sections / light cards |
| **Primary CTA** | **Dusty Rose** | `#D8A29C` | Buttons, primary actions |
| Accent | Deep Rose | `#C0837A` | Button hover, sale tags, highlights |
| Text / Dark | Charcoal | `#2A2A30` | Headlines, body, dark bars |
| Secondary | Taupe | `#C0A896` | Muted secondary elements |
| Surface | White | `#FFFFFF` | Cards, panels |
| Lines | Sand | `#ECE0D7` | Borders, dividers |

**Feel:** warm, soft, premium, feminine, clinical-clean — cream base + dusty-rose accents + crisp charcoal type.

⚠️ **Contrast:** white text on Dusty Rose `#D8A29C` fails accessibility — for key CTAs use **Deep Rose `#C0837A`** fill or **Charcoal** text.

**Typography — Satoshi** (Fontshare, free commercial; webfont: `https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap`). Used for headings *and* body:
- **Black (900)** — hero headlines · **Bold (700)** — section heads, buttons · **Medium (500)** — sub-heads/labels · **Regular (400)** — body copy.
- Accent words in headlines may use Deep Rose `#C0837A`.

---

# PART A — STRATEGIC FOUNDATIONS

## A1. Main Angles

### Angle 1 — "The Surgeon's Secret" (insider / authority) ⭐ HIGHEST POTENTIAL
- **Core promise:** The exact red-light technology surgeons use to rebuild tissue *after* a breast lift works on intact tissue *before* one — so you never need the surgery.
- **Hits hardest:** Women who've already researched or been quoted for a surgical lift.
- **Emotional driver:** Anger + vindication ("they knew and didn't tell me") + relief.
- **Sample hook:** *"Please STOP researching breast lifts until you see what your surgeon uses AFTER the procedure."*
- **Competitor status:** Perki runs this HARD in long-form ("660nm is standard protocol after every lift"). **It's proven — but they own single-wavelength 660nm. Our white space: triple red light = "more of the same light surgeons trust, reaching more of the tissue."**

### Angle 2 — "The Collagen Scaffold Collapse" (mechanism / education)
- **Core promise:** Your breasts didn't "give up" — the internal collagen scaffold thinned. Rebuild the scaffold and they lift from the inside.
- **Hits hardest:** Problem-aware women blaming themselves.
- **Emotional driver:** Self-forgiveness + hope.
- **Sample hook:** *"You didn't let yourself go. Your collagen did."* (Perki's line — we should out-mechanism it.)
- **Competitor status:** Perki owns the "scaffold" metaphor on-page. **White space: tie the rebuild explicitly to TriRed and the +collagen / −breakdown numbers.**

### Angle 3 — "$2,417 Wasted on the Surface" (failed-solutions / why-nothing-worked)
- **Core promise:** Creams, supplements, exercises and push-up bras physically *cannot reach* the 8mm-deep tissue where firmness lives. Only red light does.
- **Hits hardest:** Women who've already spent money and feel foolish.
- **Emotional driver:** Frustration → "finally, an explanation."
- **Sample hook:** *"I spent $2,417 on creams and supplements. None of it lifted a single millimeter — because the problem is 8mm deep and they all work on the surface."*
- **Competitor status:** Central to Perki's Script 1. Validated, high-converting.

### Angle 4 — "$99 vs. $20,000" (price-anchor / anti-surgery)
- **Core promise:** Same collagen science as a $20K surgery, for $99 — no scars, no drains, no 6-week recovery, no revision every 3 years.
- **Hits hardest:** Cost-conscious women who'd consider surgery "if it were safe/affordable."
- **Emotional driver:** Smart-shopper pride + risk avoidance.
- **Sample hook:** *"A breast lift is $20,000, leaves scars, and fades in 3 years. This is $99 and rebuilds your own collagen."*
- **Competitor status:** Perki's comparison table runs this. We win on price (clean $99 entry vs their $149 bundle).

### Angle 5 — "Get Your Closet Back" (identity / confidence / intimacy)
- **Core promise:** Wear the V-necks, sundresses, and swimsuits you retired — and feel like *you* again.
- **Hits hardest:** Women whose self-image and wardrobe have quietly shrunk.
- **Emotional driver:** Grief of lost identity → reclaimed confidence.
- **Sample hook:** *"Half my closet became off-limits. I never admitted why — until I got my body back."*
- **Competitor status:** Woven through Perki's story copy. Strong UGC/testimonial angle for us.

### Angle 6 — "Triple Beats Dual" (tech-superiority / direct competitor flank)
- **Core promise:** Most at-home devices use one light. Puure uses THREE red wavelengths — deeper, fuller, faster collagen activation.
- **Hits hardest:** Solution-aware comparison shoppers (already eyeing Perki/red-light devices).
- **Emotional driver:** Don't-settle / get-the-best.
- **Sample hook:** *"They use one red light. We use three. Here's why that matters for lift."*
- **Competitor status:** **Pure white space — nobody is running triple-light superiority. This is our ownable wedge.**

## A2. Unique Mechanism

**The problem — our named mechanism: "Collagen Starvation" (the silent killer of breast firmness):**
Your breasts are held up from the inside by a living scaffold — **Cooper's ligaments** woven through a lattice of **collagen and elastin**, constantly rebuilt by cells called **fibroblasts**. That's what keeps breasts firm, full, and lifted.

But after 40, and accelerating through menopause, **estrogen drops and your fibroblasts go dormant.** Collagen production falls **1–2% every year** — first 30%, then 50%, then 70% below where it was. The scaffold *starves:* it thins, slackens, and can no longer hold the weight of the tissue — so everything settles lower. **That's the sag.**

It was never weight, willpower, or "letting yourself go." It's structural **Collagen Starvation** happening roughly **8mm deep**, in the tissue itself — far below where any cream, pill, or exercise can reach. *(Anatomically validated: ptosis is driven by stretched Cooper's ligaments + age/menopause loss of collagen, elastin & estrogen — see A3.)*

**Why everything she's tried failed (the reframe that sells):**
- **Firming creams** work on the top 1–2mm of skin. The problem is 8mm down. *Like painting a house that's rotting from the inside.*
- **Collagen supplements** get digested and distributed across the whole body; the fraction reaching breast tissue is negligible. *Like pouring a glass of water in the ocean and expecting one beach to rise.*
- **Chest exercises** build the pectoral muscle *behind* the tissue. The breast itself is glandular/fatty tissue on collagen and ligaments — bigger muscle doesn't lift it. *Like inflating the cushion under a drooping curtain.*
- **Push-up bras** hide, they don't fix. Take it off and nothing changed.

**The solution (our mechanism) — "TriRed™ Triple Red Light" reawakens starved fibroblasts:**
Red/near-infrared light penetrates ~8mm — deep enough to reach the collagen layer — and re-energizes the mitochondria inside the **dormant fibroblast cells** that Collagen Starvation shut down. Reawakened fibroblasts ramp collagen synthesis back up. The scaffold rebuilds. The tissue becomes firmer, denser, more structurally supported — and lifts from the inside. Clinically, this kind of red-light stimulation is associated with **higher collagen production and lower collagen breakdown**, and it's the same wavelength surgeons rely on in post-procedure recovery.

**Why TriRed™ beats dual-spectrum / single-wavelength (our ownable edge):**
A single 660nm light hits one depth/one absorption profile. **TriRed™ uses three red wavelengths**, so collagen-producing cells are activated across a **wider band of tissue depth** — more fibroblasts switched on, more of the scaffold rebuilt, faster visible lift. *Surgeons trust red light. Puure gives you three of them instead of one.*

> **One-sentence version:** *Sagging is **Collagen Starvation** — dormant fibroblasts 8mm deep that stopped rebuilding your breasts' collagen scaffold. Puure's **TriRed™ Triple Red Light** reawakens them across three depths, so your body rebuilds its own lift from the inside.*

## A3. Market Landscape — What Women Actually Try (and why it fails)

**Root cause of sagging (ptosis):** stretched **Cooper's ligaments** + age/menopause decline in **collagen, elastin & estrogen** (worsened by pregnancies, weight changes, larger breast size, smoking, gravity). She has almost certainly climbed this ladder — cheap/DIY → clinical → surgical — and been let down at every rung:

**Tier 1 — At-home / DIY (where most start):**
- **Supportive & push-up bras** — most common; pure concealment, nothing changes underneath.
- **Chest exercises** (push-ups, presses, flys) — build the pec *muscle behind* the tissue; don't lift the tissue.
- **Firming creams / serums** (retinol, peptides, collagen) — reach only the top 1–2mm of skin.
- **Collagen / biotin supplements** — digested and diluted body-wide; negligible amount reaches the breast.
- **Breast / fashion tape** — temporary, one-outfit hold.
- **Posture, weight management, cold showers, massage, oils** — marginal / folk-remedy.
- **At-home LED / red-light / EMS gadgets** (CACI, generic masks) — right idea, usually underpowered or single-wavelength. ← *our category; our job is to be the credible, properly-engineered one.*

**Tier 2 — In-office / clinical (expensive, recurring):**
- **Radiofrequency** (Thermage, BodyTite) — collagen-based, non-surgical "gold standard"; ~$1,800+/session, temporary.
- **RF microneedling / laser / ultrasound** — "temporary and minor," repeat treatments needed.
- **PRP "vampire breast lift"** — push-up-bra *look*, doesn't treat sag; ~$1,700.
- **Thread lift** (Aptos) — ~2-year hold; ~$2,250.
- **CACI bust, Renuvion/J-plasma, Botox, fillers** — minor/temporary; Botox & fillers *not FDA-approved* for the breast.

**Tier 3 — Surgical:**
- **Breast lift (mastopexy) ± implants/fat transfer** — only dramatic fix, but **$15K–$20K**, permanent scars, 6-week recovery, drains, and it **fades in 3–5 years** → revision surgery.

**The gap we own:** between *cheap-but-useless* (Tier 1) and *effective-but-brutal/expensive* (Tier 2–3, $1,700–$20,000 + scars/recovery). Puure is the **at-home device that actually reaches the 8mm-deep cause** — clinical-grade collagen rebuilding, no clinic, no scars, no price tag.

> ⚠️ **Compliance note:** red-light evidence is still mostly small/preliminary and RF is often cited as more powerful. Keep claims to "supports/stimulates collagen," not "clinically proven to lift," until we hold our own study.

---

# PART B — THE AVATARS

We target three avatars. **Primary = "Menopause Margaret."** Secondaries below get the condensed treatment.

- **PRIMARY — "Menopause Margaret," 52–60.** Post-/peri-menopausal, kids grown, grandkids arriving. The classic Perki buyer (their #1 review: *"I'm 58… I cancelled my $14,000 breast lift"*). Collagen-loss sag, swimsuit/closet shame, has wasted money on creams, has considered or been quoted surgery.
- **SECONDARY A — "Post-Baby Paige," 32–40.** Breasts changed after pregnancy/nursing. In Script 1 she's "the 34-year-old daughter" who buys after seeing mom's results: *"She didn't wait until it was a problem."*
- **SECONDARY B — "Pre-Op Interceptor," 45–60.** Consultation booked, deposit possibly paid. Script 2's avatar — caught at the highest-intent moment. Smallest but hottest segment.

---

# PART C — SECTION-BY-SECTION (PRIMARY: "Menopause Margaret")

## 1. Demographics
- **Age:** 52–60 (sweet spot 54–58). **Income:** household $70k–$150k; comfortably disposable for a $99 purchase — she nearly spent **$15k–$20k on surgery**, so price is not the barrier; *belief* is.
- **Life stage:** post-menopause; empty-nest or grandkids arriving; long marriage. Body changed "gradually, like someone turning a dial one click at a time."
- **Urgency drivers:** an upcoming beach/pool trip, a wedding, a milestone photo, a partner's comment, or simply catching her reflection undressing.
- **Constraints:** done being "sold to," burned by past purchases, skeptical of TikTok gadgets. Needs *clinical* credibility and *risk reversal* to act.
- **Key answers:** Money? Yes, easily. Urgency? Yes — events + daily mirror dread. Constraint? Skepticism from prior failures, not budget.

## 2. Wants / Desires
- **Primary desire:** *To look in the mirror and recognize herself again — firmer, lifted breasts that sit where they used to, without surgery.*
- **Secondary desires:** wear her old wardrobe (V-necks, sundresses, swimsuits) without adjusting/layering; feel confident undressed and during intimacy; avoid the scalpel; stop wasting money; do it privately, on her couch.
- **Headline from the primary desire:** **"Lift Them Back Where They Belong — Without the Surgeon, the Scars, or the $20,000."**

## 3. Emotions / Feelings
- **Dominant emotion:** *Shame* — quiet, private, daily. She looks away from mirrors and crosses her arms in photos.
- **Supporting emotions:** **grief/loss** ("I don't recognize myself anymore"), **frustration** (nothing worked), **anger** (told it's "just normal," info withheld by surgeons), **hope tempered by skepticism** (burned too many times), **fear** (it only gets worse; losing attractiveness; intimacy fading).
- **Current state → desired state:** hiding, avoiding, layering, lights-off → relaxed, seen, wearing what she loves, *setting the swimsuit photo as her wallpaper.*

## 4. Beliefs / Identifications
- **About the problem:** "It's gravity, age, and menopause — it's normal." "I let this happen." "This is just what bodies do after 50."
- **About solutions:** "Creams and supplements are worth a try" (already disproven for her). "Surgery is the only thing that *really* works — but it's extreme, expensive, scary, and temporary." "At-home gadgets are gimmicks."
- **Limiting beliefs to overcome:** *nothing non-surgical can work; I've tried everything; it's too late for me; red-light gadgets are hype.*
- **Empowering beliefs to leverage:** *my body can rebuild its own collagen — it just needs the right signal; surgeons already use this; the problem was never me, it was depth.*

## 5. Prospect Awareness
- **Most cold traffic = Problem-Aware → Solution-Aware.** She *knows* the problem intimately and has sampled bad solutions, but is **unaware that red light reaches 8mm where creams can't**, and unaware home red-light devices exist for this.
- **Implication:** lead with the **mechanism/problem-reframe** (the surgeon's-secret + 8mm-depth story) before the product. Don't open product-first to cold audiences; teach, then reveal Puure.

## 6. Search Behavior
1. "how to firm sagging breasts" — *frustrated, problem-focused*
2. "breast lift without surgery" — *hopeful, solution-seeking*
3. "red light therapy for breasts" — *curious, solution-aware*
4. "do firming creams actually work for breasts" — *skeptical, validating*
5. "firm breasts after menopause" — *resigned but searching*
6. "non surgical breast lift that actually works" — *burned, wants proof*
7. "tighten breast skin naturally" — *gentle, early-stage*
8. "breast lift cost" — *high-intent, price-checking surgery*

## 7. Failed Solutions
| Tried | Why it failed | How it made her feel | Current view |
|---|---|---|---|
| Collagen supplements ($52/tub, 5 mo) | Digested & diluted body-wide | Foolish, ripped off | "Waste of money" |
| Firming creams ($45–$89, nightly) | Reach only 1–2mm of skin | Hopeful then deflated | "All hype" |
| Chest exercises (4 mo) | Build muscle behind tissue, not lift | Defeated despite effort | "Pointless for this" |
| $95 push-up bra | Hides, leaves welts; nothing real | Trapped in a costume | "A crutch, not a fix" |
| TikTok "firming mask" ($34) | Sheet mask, sticky residue | Embarrassed she tried it | "Gimmick" |
| Surgical consult ($15k–$20k quote) | Cost, scars, 6-wk recovery, 3-yr revision | Shaken, "deep-down wrong" | "Too extreme — there must be another way" |

## 8. Current Daily Reality
- **Morning:** gets dressed *facing the closet, not the mirror.* Reaches past the V-necks for the crew neck or cardigan. Adjusts, tugs, layers.
- **Daily limits:** half her closet is off-limits — sundresses, wrap tops, sweetheart necklines hang untouched. Layers even at 85°. No strapless, nothing fitted.
- **Social/intimate:** crosses arms in every photo; keeps a cover-up and sarong on at the pool *even in the water*; avoids intimacy or insists on lights off; can't absorb her husband's compliments because *"the issue wasn't what he thought — it was what I thought."*
- **Future fears:** "it only gets worse from here," losing her attractiveness, a surgical-maintenance life every 3 years, never feeling like herself again.

## 9. Objections & Concerns (ranked)
1. **Skepticism — "I've tried everything, this won't work either."** *Rebuttal:* everything she tried works on the surface; this is the first thing that reaches 8mm — the same red light surgeons use post-op. Show the +collagen / −breakdown data and week-by-week before/afters.
2. **Financial — "Is $99 just another wasted purchase?"** *Rebuttal:* 90-day money-back guarantee — "book the surgery in 90 days if you still want it; you've lost nothing." Anchor against $20k surgery.
3. **Safety — "Is red light on my breasts safe?"** *Rebuttal:* non-invasive, same wavelength class used in clinical/post-surgical recovery; **FDA approved**; no heat damage, no downtime.
4. **Capability/Consistency — "Will I actually keep it up?"** *Rebuttal:* just 10 min, once a day, on the couch during TV — "no learning curve." Results felt by week 1–2 keep her going.
5. **Secondary doubts:** *Am I too old?* (no — collagen responds at any age), *Will it make me bigger?* (no — it firms/lifts, doesn't enlarge), *Forever?* (use to restore, then maintain), *What if I have implants/a previous lift?* (address in FAQ).

## 10. Buying Triggers
- **Credibility builders:** the surgeon's-secret 660nm story; TriRed™ triple-light superiority; **FDA approved**; +31%-type collagen data; MD endorsement; thousands of reviews; week-by-week real-women before/afters.
- **Risk reducers:** 90-day money-back ("get every penny back"); non-surgical/no scars/no recovery; optional 1-year device warranty.
- **Emotional triggers:** the swimsuit-without-a-cover-up moment; "I looked like me again"; daughter/granddaughter noticing; reclaiming the closet.
- **Urgency creators:** intro price $99 (from $199); upcoming-event framing; "every year you wait, you lose another 1–2% of collagen."

## 11. Marketing Thesis
> **You can get visibly firmer, lifted breasts without surgery by using Puure's TriRed™ Triple Red Light to rebuild your own collagen scaffold 8mm deep — because that's the same red-light science surgeons rely on to regenerate tissue after a lift, and three wavelengths reach more of that tissue than the single-light devices (or surface creams) that failed you.**

Everything in the funnel exists to prove this one belief: *the problem was depth, not you — and red light is the only thing that reaches it.*

## 12. Ideal Success Story (usable testimonial copy)
> **Before:** "I'm 56. After menopause, everything settled lower. I dressed facing the closet so I wouldn't have to see myself in the mirror, and I hadn't worn a swimsuit without a cover-up in three years."
>
> **Skepticism moment:** "I'd already wasted over $2,000 on creams, supplements and a $95 push-up bra that left welts on my ribs. A surgeon quoted me $20,000 — for something that scars you and fades in three years. I almost didn't try one more thing."
>
> **Decision trigger:** "Then I learned surgeons use red light to rebuild tissue *after* a lift. Puure uses three red wavelengths — and it came with a 90-day money-back guarantee. Worst case, I'd get my $99 back and still book the surgery."
>
> **Journey:** "Week 1, the tissue felt different under my fingers. Week 3, my bras fit fuller — I took a side-by-side photo and I wasn't imagining it. Week 6, I pulled a scoop-neck out of the back of my closet and didn't tug it up once."
>
> **After:** "Week 12, I wore a swimsuit to the pool with my grandson — no cover-up, no crossed arms. I set that photo as my wallpaper. I cancelled my surgical consultation."
>
> **Emotional payoff:** "For the first time in years, I looked in the mirror and saw *me*. No scars. No recovery. Ten minutes a day."

---

# QUICK-REFERENCE CHEAT SHEET

**Primary avatar (one-liner):** *Menopause Margaret, 54–58 — post-menopausal, financially comfortable, ashamed of how her breasts have settled, burned by creams/supplements, scared of/priced out of surgery, secretly grieving the wardrobe and confidence she's lost.*

**Top 3 angles:** (1) The Surgeon's Secret (red light used after every lift), (2) $99 vs. $20,000 anti-surgery, (3) Triple Beats Dual (TriRed superiority — our white space).

**Unique mechanism (1 sentence):** TriRed™ Triple Red Light penetrates ~8mm to switch fibroblasts back on and rebuild the collagen scaffold — three wavelengths reaching more tissue than any single-/dual-light device or surface cream.

**Marketing thesis:** *You can get firmer, lifted breasts without surgery by rebuilding your own collagen 8mm deep with TriRed™ — the same red-light science surgeons use after a lift — because the problem was always depth, not you.*

**Top 3 objections + rebuttals:**
1. "Won't work / tried everything" → everything else hit the surface; this reaches 8mm (+collagen data, weekly before/afters).
2. "Waste of $99" → 90-day money-back; anchor vs $20k surgery.
3. "Is it safe?" → non-invasive, clinical-grade red light, **FDA approved**, no downtime.

**Top 5 hooks:**
1. *"Please STOP researching breast lifts until you see what your surgeon uses AFTER the procedure."*
2. *"I spent $2,417 on creams and supplements — none of it lifted a millimeter, because the problem is 8mm deep."*
3. *"A breast lift is $20,000, scars you, and fades in 3 years. This is $99 and rebuilds your own collagen."*
4. *"You didn't let yourself go. Your collagen did — and three red lights can bring it back."*
5. *"They use one red light. Puure uses three. Here's why that matters for lift."*

---
*Sources: Perki long-form Scripts 1 & 2; Perki advertorial/homepage ("Back Up Where They Belong," 4-phase collagen-scaffold system, +31%/−18%, Dr. Amelia Hartwell MD, Perki-vs-Surgery table, 4.7★/9,773 reviews); Perki product page ("Restoration Protocol," dual-spectrum, bundled gifts). Our facts (TriRed™ triple red light, $99/$199, device-only with gifts as upsells) are locked and override competitor specifics.*
$mdbrief$,
       updated_at = NOW()
 WHERE product_code = 'PUURE';
