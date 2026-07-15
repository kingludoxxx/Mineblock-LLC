-- Operator rules for Puure:
--  1. Avatar "Menopause Margaret" is now just "Menopause".
--  2. New bottom-of-funnel avatar "Product Aware" (offer/discount ads).
--  3. New bottom-of-funnel angle "Promo" (offer/discount ads).
--
-- Avatars are rewritten wholesale (they carry no rich clone-prompt fields).
-- Angles are APPENDED to (the existing 6 carry hook_strategy/lead_with/etc
-- that the clone prompt consumes — never rewrite them).

UPDATE product_profiles
   SET avatars = '[
     {"name":"Menopause","age_range":"52-60 (sweet spot 54-58)","life_stage":"Post-menopausal, empty-nest/grandkids","primary":true,"description":"Post-menopausal, financially comfortable ($70K-$150K household), ashamed of sagging breasts, burned by creams/supplements, considered or quoted surgery."},
     {"name":"Post-Baby Paige","age_range":"32-40","life_stage":"Postpartum/post-nursing","primary":false,"description":"Breasts changed after pregnancy/nursing. Preventative mindset: did not wait until it was a problem."},
     {"name":"Pre-Op Interceptor","age_range":"45-60","life_stage":"Surgical consultation booked or deposit paid","primary":false,"description":"Highest-intent moment: consultation booked, considering/quoted surgery. Smallest but hottest segment."},
     {"name":"Product Aware","age_range":"45-65","life_stage":"Already knows Puure","primary":false,"description":"Bottom-of-funnel. Already knows Puure and what it does. Responds to offers, discounts, limited-time deals, price drops, and scarcity. Ready to buy on the right promo. Use this avatar for any offer/sale/discount-led ad."}
   ]'::jsonb,
       updated_at = NOW()
 WHERE product_code = 'PUURE';

UPDATE product_profiles
   SET angles = angles || '[
     {"name":"Promo","funnel_stage":"bottom","description":"Offer/promo angle for bottom-of-funnel ads whose primary job is selling a discount, sale, limited-time deal, price drop, or scarcity (not educating on the problem or mechanism). Lead with the offer, the savings, the deadline, and the risk-reversal guarantee.","sample_hook":"Our biggest Puure sale of the year is live, and it ends at midnight."}
   ]'::jsonb,
       updated_at = NOW()
 WHERE product_code = 'PUURE'
   AND NOT (angles @> '[{"name":"Promo"}]'::jsonb);
