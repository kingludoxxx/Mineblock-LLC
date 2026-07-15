-- PL | Video Creatives gets its own brief-number sequence starting at B0010
-- (operator decision 2026-07-15). The first PL briefs were minted from the
-- global (MB) counter and landed at B0444+; renumber them into the new PL
-- sequence. B0011 is already taken by a manually created card, so the
-- renumbering skips 11.
UPDATE brief_pipeline_generated SET brief_number = 10 WHERE product_code = 'PUURE' AND brief_number = 444;
UPDATE brief_pipeline_generated SET brief_number = 12 WHERE product_code = 'PUURE' AND brief_number = 446;
UPDATE brief_pipeline_generated SET brief_number = 13 WHERE product_code = 'PUURE' AND brief_number = 455;
UPDATE brief_pipeline_generated SET brief_number = 14 WHERE product_code = 'PUURE' AND brief_number = 456;
UPDATE brief_pipeline_generated SET brief_number = 15 WHERE product_code = 'PUURE' AND brief_number = 457;

-- Dedicated race-free counter for the PL sequence (id=2; id=1 stays global/MB).
INSERT INTO brief_number_counter (id, value) VALUES (2, 15)
ON CONFLICT (id) DO UPDATE SET value = GREATEST(brief_number_counter.value, 15);
