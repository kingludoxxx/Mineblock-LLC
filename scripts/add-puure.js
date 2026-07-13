#!/usr/bin/env node
import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: 'require',
  connection: {
    timeout: 10000
  }
});

(async () => {
  try {
    const result = await sql`
      INSERT INTO product_profiles (
        product_code, short_name, full_name, description, price, price_from,
        key_benefits, brand_colors, fonts, angles, avatars, formats,
        created_at, updated_at
      ) VALUES (
        'PUURE',
        'Puure',
        'Puure™ Breast Lift Device v1.1',
        'At-home, non-surgical breast firming & lifting device using TriRed™ Triple Red Light Technology. Penetrates ~8mm to activate fibroblast cells and rebuild collagen + elastin in the breast scaffold for natural lift without surgery, scars, or recovery.',
        99,
        199,
        ${ JSON.stringify([
          'TriRed™ Triple Red Light Technology (3 wavelengths vs competitors single)',
          'FDA approved - clinical-grade red light therapy',
          'Non-surgical alternative to breast lift ($20K+ surgery)',
          '10 minutes daily usage at home',
          'Rebuilds collagen scaffold 8mm deep (where surface creams cannot reach)',
          'No scars, no recovery time, no downtime',
          '90-day money-back guarantee'
        ])}::jsonb,
        ${ JSON.stringify({
          background_primary: '#F7EEE7',
          background_alt: '#F9F3EE',
          cta_primary: '#D8A29C',
          cta_hover: '#C0837A',
          text_dark: '#2A2A30',
          secondary: '#C0A896',
          surface: '#FFFFFF',
          borders: '#ECE0D7',
          feel: 'warm, soft, premium, feminine, clinical-clean'
        })}::jsonb,
        ${ JSON.stringify({
          primary_font: 'Satoshi',
          weights: '400, 500, 700, 900',
          hero_weight: '900',
          button_weight: '700',
          body_weight: '400',
          webfont_url: 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap'
        })}::jsonb,
        ${ JSON.stringify([
          {
            name: 'The Surgeon\'s Secret',
            funnel_stage: 'top',
            description: 'Insider/authority: Red-light technology surgeons use AFTER a breast lift works on intact tissue BEFORE one.',
            sample_hook: 'Please STOP researching breast lifts until you see what your surgeon uses AFTER the procedure.'
          },
          {
            name: 'The Collagen Scaffold Collapse',
            funnel_stage: 'top',
            description: 'Mechanism/education: Sagging is caused by collagen starvation in the breast scaffold.',
            sample_hook: 'You didn\'t let yourself go. Your collagen did — and three red lights can bring it back.'
          },
          {
            name: '$2,417 Wasted on the Surface',
            funnel_stage: 'middle',
            description: 'Failed-solutions: Creams, supplements, exercises cannot reach the 8mm-deep tissue where firmness lives.',
            sample_hook: 'I spent $2,417 on creams and supplements — none of it lifted a millimeter, because the problem is 8mm deep.'
          },
          {
            name: '$99 vs. $20,000',
            funnel_stage: 'bottom',
            description: 'Price-anchor/anti-surgery: Same collagen science as a $20K surgery, for $99.',
            sample_hook: 'A breast lift is $20,000, scars you, and fades in 3 years. This is $99 and rebuilds your own collagen.'
          },
          {
            name: 'Get Your Closet Back',
            funnel_stage: 'middle',
            description: 'Identity/confidence/intimacy: Wear the V-necks, sundresses, and swimsuits you retired.',
            sample_hook: 'Half my closet became off-limits. I never admitted why — until I got my body back.'
          },
          {
            name: 'Triple Beats Dual',
            funnel_stage: 'top',
            description: 'Tech-superiority/competitive: Most devices use one light. Puure uses THREE wavelengths.',
            sample_hook: 'They use one red light. Puure uses three. Here\'s why that matters for lift.'
          }
        ])}::jsonb,
        ${ JSON.stringify([
          {
            name: 'Menopause Margaret',
            age_range: '52-60 (sweet spot 54-58)',
            life_stage: 'Post-menopausal, empty-nest/grandkids',
            primary: true,
            description: 'Post-menopausal, financially comfortable ($70K-$150K household), ashamed of sagging breasts, burned by creams/supplements, considered or quoted surgery.'
          },
          {
            name: 'Post-Baby Paige',
            age_range: '32-40',
            life_stage: 'Postpartum/post-nursing',
            primary: false,
            description: 'Breasts changed after pregnancy/nursing. Preventative mindset: didn\'t wait until it was a problem.'
          },
          {
            name: 'Pre-Op Interceptor',
            age_range: '45-60',
            life_stage: 'Surgical consultation booked or deposit paid',
            primary: false,
            description: 'Highest-intent moment: consultation booked, considering/quoted surgery. Smallest but hottest segment.'
          }
        ])}::jsonb,
        ${ JSON.stringify([
          { name: 'UGC Testimonial', description: 'Real-woman before/after testimonial story' },
          { name: 'Expert Authority', description: 'MD/surgeon explanation of TriRed science' },
          { name: 'Lifestyle', description: 'Woman wearing reclaimed wardrobe (V-neck, swimsuit, sundress)' },
          { name: 'Problem/Solution', description: 'Mechanism breakdown: collagen starvation → TriRed fix' },
          { name: 'Comparison', description: 'Puure ($99) vs. surgery ($20K) vs. failed solutions' }
        ])}::jsonb,
        NOW(),
        NOW()
      )
      ON CONFLICT (product_code) DO UPDATE SET
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
        updated_at = NOW()
      RETURNING product_code, short_name, full_name, price;
    `;

    console.log('\n✅ Puure product added to library:');
    console.log(`   Code: ${result[0].product_code}`);
    console.log(`   Name: ${result[0].full_name}`);
    console.log(`   Price: $${result[0].price}`);
    console.log('\n🎯 Ready to generate briefs with Puure in Brief Pipeline!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error adding Puure:', err.message);
    process.exit(1);
  }
})();
