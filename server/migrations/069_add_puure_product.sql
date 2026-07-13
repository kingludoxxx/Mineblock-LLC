-- Add Puure™ Breast Lift Device to product library.
-- Written against the REAL product_profiles schema (see ensureTable in
-- server/src/routes/productProfiles.js): `name` is the NOT NULL display column
-- (there is no full_name), price is TEXT, avatar/mechanism/voice are TEXT,
-- benefits/angles/avatars/formats/brand_colors/fonts are JSONB.
-- product_code has no UNIQUE constraint, so idempotency uses WHERE NOT EXISTS
-- instead of ON CONFLICT.
INSERT INTO product_profiles (
  name,
  short_name,
  product_code,
  category,
  price,
  price_from,
  description,
  oneliner,
  big_promise,
  mechanism,
  differentiator,
  customer_avatar,
  customer_frustration,
  customer_dream,
  voice,
  competitive_edge,
  guarantee,
  target_demographics,
  pain_points,
  common_objections,
  benefits,
  key_benefits,
  angles,
  avatars,
  formats,
  brand_colors,
  fonts,
  created_at,
  updated_at
)
SELECT
  'Puure',
  'PU',
  'PUURE',
  'beauty_device',
  '$99',
  '$199',
  'At-home, non-surgical breast firming & lifting device using TriRed™ Triple Red Light Technology. Penetrates ~8mm to activate fibroblast cells and rebuild collagen + elastin in the breast scaffold for natural lift without surgery, scars, or recovery. FDA approved, 10 minutes daily.',
  'The $99 at-home breast lift: three red-light wavelengths rebuild your collagen scaffold 8mm deep — no surgery, no scars, no recovery.',
  'A visibly firmer, lifted chest from 10 minutes a day at home — the same collagen science as a $20,000 breast lift, for $99, with zero scars and zero downtime.',
  'TriRed™ Triple Red Light Technology combines three red wavelengths that penetrate ~8mm into breast tissue — where surface creams cannot reach — activating fibroblast cells to rebuild the collagen + elastin scaffold. As the scaffold rebuilds, the breast lifts and firms from the inside.',
  'Three red wavelengths vs. competitors'' one — deeper penetration, fuller coverage, faster results. FDA approved clinical-grade red light. Non-surgical alternative to a $20K+ breast lift. 10 minutes daily, 90-day money-back guarantee.',
  'Menopause Margaret, 52-60 (sweet spot 54-58). Post-menopausal, financially comfortable ($70K-$150K household), ashamed of sagging breasts, burned by creams and supplements, has considered or been quoted breast lift surgery. Secondary: Post-Baby Paige (32-40, postpartum/post-nursing, preventative mindset) and the Pre-Op Interceptor (45-60, surgical consultation booked — smallest but hottest segment).',
  'Has spent hundreds to thousands on firming creams, supplements, and chest exercises that never lifted a millimeter. Half her closet — V-necks, sundresses, swimsuits — has quietly become off-limits. Surgery feels extreme: $20K+, scars, drains, 6-week recovery, and results that fade.',
  'To wear the clothes she retired and feel like herself again — a natural lift from her own rebuilt collagen, achieved privately at home, without going under the knife.',
  'Warm, direct, respectful — never shame-based. Speaks to women 55+ as intelligent adults. Educational and mechanism-first: every claim tied to the collagen scaffold science. No hype, no medical fear-mongering.',
  'vs. surgery: $99 instead of $20,000+, no scars, no drains, no 6-week recovery, results from your own collagen. vs. creams/supplements: they stop at the skin surface — firmness lives 8mm deep where only red light reaches. vs. single-light devices: Puure uses THREE red wavelengths for deeper, fuller, faster stimulation.',
  '90-day money-back guarantee.',
  'Women 45-60+, primary segment post-menopausal 52-60, US, household income $70K-$150K, previous buyers of firming creams/supplements, surgery researchers and consult-bookers.',
  'Sagging/deflated breasts after menopause or breastfeeding; wasted money on surface solutions; wardrobe limitations; loss of confidence in intimacy; fear of surgery costs, scars, and recovery.',
  '"Does red light actually work or is this another gimmick?" / "I''ve already wasted money on creams — why is this different?" / "Is it safe to use on breast tissue?" / "How long until I see results?"',
  '[
    "TriRed™ Triple Red Light Technology (3 wavelengths vs competitors'' 1)",
    "FDA approved - clinical-grade red light therapy",
    "Non-surgical alternative to breast lift ($20K+ surgery)",
    "10 minutes daily usage at home",
    "Rebuilds collagen scaffold 8mm deep (where surface creams cannot reach)",
    "No scars, no recovery time, no downtime",
    "90-day money-back guarantee"
  ]'::jsonb,
  '[
    "TriRed™ Triple Red Light Technology (3 wavelengths vs competitors'' 1)",
    "FDA approved - clinical-grade red light therapy",
    "Non-surgical alternative to breast lift ($20K+ surgery)",
    "10 minutes daily usage at home",
    "Rebuilds collagen scaffold 8mm deep (where surface creams cannot reach)",
    "No scars, no recovery time, no downtime",
    "90-day money-back guarantee"
  ]'::jsonb,
  '[
    {
      "id": "puure_angle_001",
      "name": "The Surgeon''s Secret",
      "funnel_stage": "top",
      "hook_strategy": "Insider/authority angle. Interrupt the surgery-research journey with a credibility bomb: the same red-light technology surgeons prescribe AFTER a breast lift works on intact tissue BEFORE one.",
      "lead_with": "Surgeons use red light therapy after breast lifts to rebuild collagen at the incision. That same technology works on intact tissue — before anyone ever cuts. Puure brings the post-op protocol home, without the operation.",
      "tone": "Calm clinical authority. An insider sharing what the industry already knows, not a brand making claims.",
      "headline_examples": [
        "Please STOP researching breast lifts until you see what your surgeon uses AFTER the procedure.",
        "The post-surgery protocol that works before surgery.",
        "Surgeons already trust this technology. They just use it too late."
      ],
      "banned_phrases": ["miracle", "guaranteed results", "look 20 again"]
    },
    {
      "id": "puure_angle_002",
      "name": "The Collagen Scaffold Collapse",
      "funnel_stage": "top",
      "hook_strategy": "Mechanism/education angle. Reframe sagging from personal failure to biological cause: collagen starvation in the breast scaffold. Rebuild the scaffold and the breast lifts from the inside.",
      "lead_with": "Sagging isn''t about weight, age, or letting yourself go. It''s the collagen scaffold inside the breast slowly starving. Three red wavelengths reach 8mm deep and tell fibroblast cells to start rebuilding it.",
      "tone": "Educational, absolving, empowering. The viewer learns something real about her body in the first 10 seconds.",
      "headline_examples": [
        "You didn''t let yourself go. Your collagen did — and three red lights can bring it back.",
        "Sagging is a scaffold problem. Fix the scaffold.",
        "8mm below the skin is where firmness lives."
      ],
      "banned_phrases": ["anti-aging miracle", "fountain of youth"]
    },
    {
      "id": "puure_angle_003",
      "name": "$2,417 Wasted on the Surface",
      "funnel_stage": "middle",
      "hook_strategy": "Failed-solutions angle. Validate the money she has already burned on creams, supplements, and exercises — then explain WHY they failed: they cannot reach the 8mm-deep tissue where firmness lives. Only red light does.",
      "lead_with": "I spent $2,417 on firming creams and collagen supplements — none of it lifted a millimeter. Because the problem is 8mm deep, and creams stop at the surface.",
      "tone": "First-person confession turned discovery. Sympathetic to past purchases — the products failed her, she did not fail.",
      "headline_examples": [
        "I spent $2,417 on creams and supplements — none of it lifted a millimeter, because the problem is 8mm deep.",
        "Your firming cream stops at the skin. Your sagging starts 8mm below it.",
        "Creams treat the surface. The scaffold is the problem."
      ],
      "banned_phrases": ["scam", "they lied to you"]
    },
    {
      "id": "puure_angle_004",
      "name": "$99 vs. $20,000",
      "funnel_stage": "bottom",
      "hook_strategy": "Price-anchor / anti-surgery angle. Anchor against the $20K surgical quote: same collagen science, $99, no scars, no drains, no 6-week recovery — and surgical results fade in ~3 years anyway.",
      "lead_with": "A breast lift costs $20,000, leaves scars, needs 6 weeks of recovery — and starts fading in 3 years. This is $99 and rebuilds your own collagen instead of cutting.",
      "tone": "Direct, numerical, decisive. Built for the woman who already has a quote in her inbox.",
      "headline_examples": [
        "A breast lift is $20,000, scars you, and fades in 3 years. This is $99 and rebuilds your own collagen.",
        "$99 vs $20,000. Same collagen science. Zero scalpels.",
        "Cancel the consult. Keep the $19,901."
      ],
      "banned_phrases": ["better than surgery for everyone", "surgeons hate this"]
    },
    {
      "id": "puure_angle_005",
      "name": "Get Your Closet Back",
      "funnel_stage": "middle",
      "hook_strategy": "Identity/confidence/intimacy angle. The emotional cost is measured in retired clothing: the V-necks, sundresses, and swimsuits she quietly stopped wearing. The payoff is wearing them again.",
      "lead_with": "Half my closet became off-limits — V-necks, sundresses, the swimsuit from that trip. I never admitted why. Ten minutes a day gave me my closet back.",
      "tone": "Intimate, story-driven, first-person. Quiet vulnerability resolving into quiet confidence — never pity.",
      "headline_examples": [
        "Half my closet became off-limits. I never admitted why — until I got my body back.",
        "The sundress test.",
        "She stopped buying V-necks in 2019. Ask her why she started again."
      ],
      "banned_phrases": ["sexy again", "husband will thank you"]
    },
    {
      "id": "puure_angle_006",
      "name": "Triple Beats Dual",
      "funnel_stage": "top",
      "hook_strategy": "Tech-superiority / competitive flank. Most at-home red-light devices use a single wavelength. Puure uses THREE red wavelengths — deeper penetration, fuller coverage, faster results. Position as the category upgrade.",
      "lead_with": "They use one red light. Puure uses three. Different wavelengths penetrate to different depths — one light leaves most of the scaffold untouched.",
      "tone": "Confident spec-comparison. Slightly competitive, evidence-first, no trash talk.",
      "headline_examples": [
        "They use one red light. Puure uses three. Here''s why that matters for lift.",
        "One wavelength is a flashlight. Three is a protocol.",
        "Triple wavelength. Triple depth. That''s the difference."
      ],
      "banned_phrases": ["all other devices are useless"]
    }
  ]'::jsonb,
  '[
    {
      "name": "Menopause Margaret",
      "age_range": "52-60 (sweet spot 54-58)",
      "life_stage": "Post-menopausal, empty-nest/grandkids",
      "primary": true,
      "description": "Post-menopausal, financially comfortable ($70K-$150K household), ashamed of sagging breasts, burned by creams/supplements, considered or quoted surgery."
    },
    {
      "name": "Post-Baby Paige",
      "age_range": "32-40",
      "life_stage": "Postpartum/post-nursing",
      "primary": false,
      "description": "Breasts changed after pregnancy/nursing. Preventative mindset: did not wait until it was a problem."
    },
    {
      "name": "Pre-Op Interceptor",
      "age_range": "45-60",
      "life_stage": "Surgical consultation booked or deposit paid",
      "primary": false,
      "description": "Highest-intent moment: consultation booked, considering/quoted surgery. Smallest but hottest segment."
    }
  ]'::jsonb,
  '[
    { "name": "UGC Testimonial", "description": "Real-woman before/after testimonial story with emotional journey" },
    { "name": "Expert Authority", "description": "MD/surgeon explanation of TriRed science and collagen mechanism" },
    { "name": "Lifestyle", "description": "Woman wearing reclaimed wardrobe (V-neck, swimsuit, sundress, no cover-up)" },
    { "name": "Problem/Solution", "description": "Mechanism breakdown: collagen starvation deep tissue -> TriRed triple wavelength fix" },
    { "name": "Comparison", "description": "Puure ($99) vs. surgery ($20K cost) vs. failed solutions (creams, supplements)" }
  ]'::jsonb,
  '{
    "background_primary": "#F7EEE7",
    "background_alt": "#F9F3EE",
    "cta_primary": "#D8A29C",
    "cta_hover": "#C0837A",
    "text_dark": "#2A2A30",
    "secondary": "#C0A896",
    "surface": "#FFFFFF",
    "borders": "#ECE0D7",
    "feel": "warm, soft, premium, feminine, clinical-clean"
  }'::jsonb,
  '[
    {
      "name": "Satoshi",
      "weights": "400, 500, 700, 900",
      "hero_weight": "900",
      "button_weight": "700",
      "body_weight": "400",
      "webfont_url": "https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap"
    }
  ]'::jsonb,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM product_profiles WHERE product_code = 'PUURE'
);
