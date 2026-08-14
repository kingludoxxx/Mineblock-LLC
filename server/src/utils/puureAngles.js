// Puure — the 6 canonical marketing angles, in the product_profiles.angles shape.
// Source of truth for BOTH the brief pipeline (already consumes product_profiles.angles)
// and the static pipeline (to be wired). Each object also carries `avatar` +
// `awareness` + `funnel` so the AI has who/where context, not just the hook.
// Grounded in PUURE-CREATIVE-STRATEGY.md + the winners read (Mechanism + an
// authority messenger, cold menopausal woman, is the proven-winning formula).

export const PUURE_ANGLES = [
  {
    id: 'pl_angle_mechanism',
    name: 'Mechanism',
    funnel_stage: 'top',
    avatar: 'Woman 45-70, post-menopause, breasts have softened and dropped, blames age/weight and feels there is nothing to be done.',
    awareness: 'Problem-aware → Solution-aware',
    hook_strategy: 'She thinks the sag is just age and irreversible. Reframe it as a SPECIFIC, fixable cause she has never heard named, delivered by a credible authority (dermatologist / surgeon). Naming the cause is the whole hook — it makes her feel understood and gives her hope there is a fix. This is our single highest-converting angle.',
    lead_with: 'Your breasts are not sagging because of age. After menopause a cell called the fibroblast goes dormant and stops rebuilding the collagen scaffold 8mm beneath the skin. That is why creams and chest exercises never change anything, they cannot reach that layer. Red light is designed to wake those cells back up so the lift comes from the inside.',
    tone: 'Calm clinical authority. A doctor explaining what she has seen in her own patients. Educational, not salesy. Certainty without hype. The viewer should feel she is finally getting the real explanation.',
    copy_directives: `- Open by overturning the wrong belief ("not age, not weight")
- Name the mechanism precisely: fibroblasts, collagen scaffold, ~8mm depth, "Collagen Starvation"
- Explain WHY the usual fixes fail (surface vs the deep layer) before selling ours
- Position red light as designed to reach the exact layer where the problem lives
- Lead with an authority messenger (dermatologist / surgeon), never a generic voice
- Concrete over vague: "the factories go dark", "the scaffold collapses"
- Close on the fix + a soft next step, let the mechanism do the persuading`,
    required_elements: [
      'The named cause (Collagen Starvation / dormant fibroblasts)',
      'The depth detail (~8mm collagen scaffold)',
      'Why creams + workouts cannot fix it',
      'An authority messenger (dermatologist or surgeon)',
    ],
    headline_examples: [
      'Your breasts are not sagging from age. A cell quietly switched off.',
      'The real reason breasts drop after 50, and it is not what you think',
      'Creams sit on top. The problem is 8mm down.',
      'After menopause one cell stops rebuilding your collagen',
      'A dermatologist explains why your chest keeps dropping',
    ],
    banned_phrases: ['miracle', 'instant', 'guaranteed results', 'clinically proven to cure', 'anti-aging secret'],
    messenger: 'Dermatologist / Surgeon (authority)',
    created_at: new Date().toISOString(),
  },
  {
    id: 'pl_angle_secret',
    name: 'Secret',
    funnel_stage: 'top',
    avatar: 'Woman 50+ who feels the surgery/beauty industry is built to take her money; primed to distrust, but hungry for an insider truth.',
    awareness: 'Problem-aware',
    hook_strategy: 'An insider (a confessing surgeon) breaks ranks and reveals the treatment the industry buried because it makes women stop booking surgery. The betrayal + confession creates intrigue and instant credibility. Pairs the Mechanism with a story engine.',
    lead_with: 'I performed breast lifts for years before I admitted what I was keeping from my patients. There is a red-light treatment clinics use quietly that firms sagging tissue, and no surgeon tells you, because a woman who fixes it at home stops booking $1,800 sessions.',
    tone: 'Confessional, a little angry at the industry, protective of the viewer. One professional finally telling the truth. Sincere, not clickbait.',
    copy_directives: `- Open with the confession/insider reveal in the first line
- Name the villain (the surgery/clinic industry and its incentives), never the viewer
- Explain WHY it was hidden (money) so the secret feels real
- Bridge into the mechanism (red light / collagen) as the suppressed truth
- Keep the messenger a credible insider (surgeon / clinic nurse)
- End on "I am done keeping it quiet" + the at-home fix`,
    lead_examples_note: 'Confessing-surgeon (Dr. persona) is the workhorse messenger here.',
    required_elements: [
      'An insider confession / "they hid this" reveal',
      'The money motive for why it was suppressed',
      'The red-light mechanism as the secret',
      'A credible insider messenger',
    ],
    headline_examples: [
      'I am a surgeon. Here is what we do not tell you about sagging breasts.',
      'The breast treatment clinics use but never advertise',
      'They buried this because it stops women booking surgery',
      'A plastic surgeon finally breaks the silence',
    ],
    banned_phrases: ['doctors hate her', 'one weird trick', 'shocking secret', 'they do not want you to know (as clickbait)'],
    messenger: 'Confessing Surgeon / Clinic insider',
    created_at: new Date().toISOString(),
  },
  {
    id: 'pl_angle_antisurgery',
    name: 'AntiSurgery',
    funnel_stage: 'middle',
    avatar: 'Woman actively considering or about to book a $15-20k surgical lift; high intent, scared of scars/recovery/cost.',
    awareness: 'Solution-aware',
    hook_strategy: 'She has already decided the SOLUTION is surgery. Intercept that decision: same result, none of the scars, downtime, or five-figure cost. Make surgery the expensive, risky option and Puure the smart one.',
    lead_with: 'Before you book that breast lift, look at what it actually costs you: up to twenty thousand dollars, scars under each breast, drains, weeks of recovery, and a revision down the line. There is a way to firm and lift at home, ten minutes a day, for a tiny fraction of that.',
    tone: 'Warm, protective, practical. A friend who has done the math talking her out of a mistake she is about to make. Never fear-mongering, just honest cost/risk.',
    copy_directives: `- Assume high intent: she is close to booking, so open there
- Stack the true cost of surgery: money, scars, anesthesia, recovery, revisions
- Contrast against at-home: no surgery, no scars, no downtime, fraction of the cost
- Use the price anchor ($15-20k vs the Puure price) explicitly
- Optionally use a "surgeon friend told me to cancel" or "I almost booked it" testimonial frame
- End: try the at-home path first, surgery is always still there`,
    required_elements: [
      'The surgery cost anchor ($15-20k)',
      'The full downside of surgery (scars, recovery, revision)',
      'The at-home contrast (10 min/day, no downtime)',
      'A "cancel the surgery" or "almost booked it" moment',
    ],
    headline_examples: [
      'Before you spend $20,000 on a breast lift, watch this',
      'A surgeon friend told me to cancel my lift. Here is why.',
      'Same lift. No scars. No $20,000.',
      'I was six days from booking surgery. Then I found this.',
    ],
    banned_phrases: ['surgery is dangerous (as a blanket claim)', 'never get surgery', 'doctors are lying to you'],
    messenger: 'Surgeon / Nurse / Almost-booked customer',
    created_at: new Date().toISOString(),
  },
  {
    id: 'pl_angle_comparison',
    name: 'Comparison',
    funnel_stage: 'middle',
    avatar: 'Skeptical comparison-shopper who has tried creams/bras/exercises and wants to see how options actually stack up before spending.',
    awareness: 'Solution-aware',
    hook_strategy: 'She is in evaluation mode, comparing options. Give her the head-to-head she is already trying to do in her head: Puure vs surgery vs creams, on the criteria that matter (cost, how it works, downtime, results). Let the table make the case. This is the listicle / advertorial engine and our thinnest coverage, so lean in.',
    lead_with: 'We compared every way women try to lift sagging breasts: surgery, firming creams, bras, exercises, and at-home red light. On cost, safety, downtime, and whether it touches the real cause, only one actually holds up.',
    tone: 'Editorial, neutral, evidence-first. Reads like a magazine "we tested them all" review, not an ad. Fairness earns the recommendation.',
    copy_directives: `- Frame as an objective head-to-head / ranking / "X reasons" listicle
- Use a comparison table: rows = cost, how it works, downtime, risk, results
- Be fair to the alternatives, then show where each falls short
- Puure wins on the criteria, do not just assert it
- Great as a long advertorial that a cold ad clicks into (fills the MOF gap)
- End with the ranked recommendation + a soft CTA`,
    required_elements: [
      'A comparison table (Puure vs surgery vs creams)',
      'Clear criteria (cost / mechanism / downtime / results)',
      'Fair treatment of alternatives before the verdict',
      'A ranked recommendation',
    ],
    headline_examples: [
      'We compared the 5 most popular ways to lift sagging breasts',
      '10 reasons women over 50 are choosing red light over surgery',
      'Surgery vs creams vs red light: what actually holds up',
      'Puure vs a $20k lift, side by side',
    ],
    banned_phrases: ['the only thing that works (as unqualified absolute)', 'everything else is a scam'],
    messenger: 'Editorial voice / Lay reviewer',
    created_at: new Date().toISOString(),
  },
  {
    id: 'pl_angle_socialproof',
    name: 'SocialProof',
    funnel_stage: 'middle',
    avatar: 'Woman who aspires to look like ageless women her age (celebrities, friends) and moves when she sees others like her succeeding.',
    awareness: 'Solution-aware',
    hook_strategy: 'She wants proof from people, not mechanisms. Show the aspirational figure (a celebrity who stays lifted) or a wave of women like her switching, and reveal red light as the method behind it. Belonging + aspiration.',
    lead_with: 'Ever wonder how women like Demi and JLo still look lifted at their age without obvious surgery? It is not just good genes. The method behind it is a red-light treatment, and it is finally available to use at home.',
    tone: 'Warm, aspirational, a little insider-gossip. "Here is the thing they all quietly use." Relatable, not preachy.',
    copy_directives: `- Lead with the aspirational figure or the "everyone is switching" wave
- Reveal red light as the shared method behind the look
- Bring it back down to earth: now she can do it at home
- Use real-woman testimonials / a husband-noticed moment where it fits
- Never fabricate specific claims about a named celebrity, keep it "the method they use"
- End on belonging: join the women already doing it`,
    required_elements: [
      'An aspirational anchor (celebrity look or a wave of women)',
      'The reveal that red light is the shared method',
      'A relatable "now you can too, at home" bridge',
      'Real-woman proof where possible',
    ],
    headline_examples: [
      'How ageless women stay lifted without surgery',
      'The red-light method women over 50 are quietly switching to',
      'My husband asked if I had something done. I did not.',
      'Why thousands of women retired their padded bras this year',
    ],
    banned_phrases: ['[celebrity] uses Puure (fabricated endorsement)', 'as seen on (unverified)', 'join thousands (as filler)'],
    messenger: 'Celebrity breakdown / Husband advocate / Real woman',
    created_at: new Date().toISOString(),
  },
  {
    id: 'pl_angle_promo',
    name: 'Promo',
    funnel_stage: 'bottom',
    avatar: 'Product-aware / deal-seeking woman who already knows and half-wants Puure; needs a reason to act now.',
    awareness: 'Product-aware → Most-aware',
    hook_strategy: 'She already knows Puure and is on the fence about price/timing. Do not re-educate, give her the deal and a reason to move now: sale, guarantee, scarcity, or an objection reframed. Retargeting and BOF only.',
    lead_with: 'If you have been thinking about Puure, this is the moment. It is 50% off today with free discreet shipping, and it is backed by a 90-day money-back guarantee, so if you are not visibly firmer you send one email and get your money back.',
    tone: 'Direct, upbeat, low-friction. Warm nudge, not desperation. The guarantee removes the risk, the deal removes the delay.',
    copy_directives: `- Assume she already knows the product, skip the education
- Lead with the offer: price, free shipping, and the risk-reversal guarantee
- Handle the one blocking objection (cost / "will it work for me") head on
- Use honest urgency (real sale, real stock), never fabricated countdowns
- Keep the guarantee central, it does the heavy lifting at BOF
- One clear CTA`,
    required_elements: [
      'The concrete offer (discount + free shipping)',
      'The 90-day money-back guarantee (risk reversal)',
      'One objection handled',
      'A single clear CTA',
    ],
    headline_examples: [
      'Your Puure is 50% off today, with a 90-day money-back guarantee',
      'Still thinking about it? Try it risk-free for 90 days.',
      'Best price of the year on Puure ends soon',
      'If it does not firm your chest, you do not pay.',
    ],
    banned_phrases: ['fake countdown timer', 'only 3 left (if untrue)', 'act now or lose forever', 'FDA approved (unless cleared for the exact claim)'],
    messenger: 'Everyday woman / Direct brand voice',
    created_at: new Date().toISOString(),
  },
];

