-- Two Puure briefs were pushed minutes before the PL sequence fix deployed
-- and took the last global-style numbers (458/459). Fold them into the PL
-- sequence and pull the PL counter back so the next brief is B0014.
UPDATE brief_pipeline_generated SET brief_number = 12 WHERE product_code = 'PUURE' AND brief_number = 458;
UPDATE brief_pipeline_generated SET brief_number = 13 WHERE product_code = 'PUURE' AND brief_number = 459;
UPDATE brief_number_counter SET value = 13 WHERE id = 2 AND value > 13;
