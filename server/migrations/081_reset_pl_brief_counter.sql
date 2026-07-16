-- Resync the Puure (PL) brief-number counter with reality.
--
-- Bug: allocateBriefNumber() mints numbers with
--   UPDATE brief_number_counter SET value = GREATEST(value, <floor>) + 1
-- where <floor> comes from getNextBriefNumber() (a live scan of the PL ClickUp
-- list + the DB). The counter therefore WINS whenever it is higher than the
-- floor. The PL counter (id = 2) was left at 457 by earlier throwaway test
-- generations: those test briefs were deleted from brief_pipeline_generated,
-- but nothing ever rewound the counter. Result: the next generated brief came
-- out B0458 instead of B0022, completely out of sync with the real ClickUp
-- board (whose highest card is B0021).
--
-- Fix: rewind the PL counter to the true current maximum, so the ClickUp-scan
-- floor takes over again and the next generation lands on B0022.
--
-- The real max is 21: briefs B0009-B0021 were created straight in ClickUp and
-- deliberately do NOT exist in brief_pipeline_generated (whose PL max is only
-- 13), so the DB alone cannot tell us the true ceiling — hence the literal 21.
-- GREATEST() guards against rewinding BELOW any PL brief the DB does know
-- about, which would hand out a duplicate number.
--
-- Safe to re-run: it is a plain assignment, not an increment. From here on the
-- floor keeps the counter honest, so manual cards added later can't desync it.
UPDATE brief_number_counter
   SET value = GREATEST(
     21,
     COALESCE(
       (SELECT MAX(brief_number)
          FROM brief_pipeline_generated
         WHERE product_code IN ('PUURE', 'PL')),
       0
     )
   )
 WHERE id = 2;
