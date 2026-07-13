-- Add Puure™ Breast Lift Device to product library
INSERT INTO product_profiles (
  product_code,
  short_name,
  full_name,
  description,
  price,
  price_from,
  key_benefits,
  brand_colors,
  fonts,
  angles,
  avatars,
  formats,
  created_at,
  updated_at
) VALUES (
  'PUURE',
  'Puure',
  'Puure™ Breast Lift Device v1.1',
  'At-home, non-surgical breast firming & lifting device using TriRed™ Triple Red Light Technology. Penetrates ~8mm to activate fibroblast cells and rebuild collagen + elastin in the breast scaffold for natural lift without surgery, scars, or recovery.',
  99,
  199,
  '[
    "TriRed™ Triple Red Light Technology (3 wavelengths vs competitors'' 1)",
    "FDA approved - clinical-grade red light therapy",
    "Non-surgical alternative to breast lift ($20K+ surgery)",
    "10 minutes daily usage at home",
    "Rebuilds collagen scaffold 8mm deep (where surface creams cannot reach)",
    "No scars, no recovery time, no downtime",
    "90-day money-back guarantee"
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
  '{
    "primary_font": "Satoshi",
    "weights": "400, 500, 700, 900",
    "hero_weight": "900",
    "button_weight": "700",
    "body_weight": "400",
    "webfont_url": "https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap"
  }'::jsonb,
  '[
    {
      "name": "The Surgeon''s Secret",
      "funnel_stage": "top",
      "description": "Insider/authority angle: Red-light technology surgeons use AFTER a breast lift works on intact tissue BEFORE one. The same science, at-home, without the surgery.",
      "sample_hook": "Please STOP researching breast lifts until you see what your surgeon uses AFTER the procedure."
    },
    {
      "name": "The Collagen Scaffold Collapse",
      "funnel_stage": "top",
      "description": "Mechanism/education angle: Sagging is caused by collagen starvation in the breast scaffold. Rebuild the scaffold and they lift from the inside.",
      "sample_hook": "You didn''t let yourself go. Your collagen did — and three red lights can bring it back."
    },
    {
      "name": "$2,417 Wasted on the Surface",
      "funnel_stage": "middle",
      "description": "Failed-solutions angle: Creams, supplements, exercises cannot reach the 8mm-deep tissue where firmness lives. Only red light does.",
      "sample_hook": "I spent $2,417 on creams and supplements — none of it lifted a millimeter, because the problem is 8mm deep."
    },
    {
      "name": "$99 vs. $20,000",
      "funnel_stage": "bottom",
      "description": "Price-anchor/anti-surgery angle: Same collagen science as a $20K surgery, for $99 — no scars, no drains, no 6-week recovery.",
      "sample_hook": "A breast lift is $20,000, scars you, and fades in 3 years. This is $99 and rebuilds your own collagen."
    },
    {
      "name": "Get Your Closet Back",
      "funnel_stage": "middle",
      "description": "Identity/confidence/intimacy angle: Wear the V-necks, sundresses, and swimsuits you retired — and feel like you again.",
      "sample_hook": "Half my closet became off-limits. I never admitted why — until I got my body back."
    },
    {
      "name": "Triple Beats Dual",
      "funnel_stage": "top",
      "description": "Tech-superiority/competitive flank: Most at-home devices use one light. Puure uses THREE red wavelengths — deeper, fuller, faster.",
      "sample_hook": "They use one red light. Puure uses three. Here''s why that matters for lift."
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
    {
      "name": "UGC Testimonial",
      "description": "Real-woman before/after testimonial story with emotional journey"
    },
    {
      "name": "Expert Authority",
      "description": "MD/surgeon explanation of TriRed science and collagen mechanism"
    },
    {
      "name": "Lifestyle",
      "description": "Woman wearing reclaimed wardrobe (V-neck, swimsuit, sundress, no cover-up)"
    },
    {
      "name": "Problem/Solution",
      "description": "Mechanism breakdown: collagen starvation deep tissue → TriRed triple wavelength fix"
    },
    {
      "name": "Comparison",
      "description": "Puure ($99) vs. surgery ($20K cost) vs. failed solutions (creams, supplements)"
    }
  ]'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT (product_code) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  price_from = EXCLUDED.price_from,
  key_benefits = EXCLUDED.key_benefits,
  brand_colors = EXCLUDED.brand_colors,
  fonts = EXCLUDED.fonts,
  angles = EXCLUDED.angles,
  avatars = EXCLUDED.avatars,
  formats = EXCLUDED.formats,
  updated_at = NOW();
