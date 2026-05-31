-- Operator-driven dismissal of TripleWhale-sourced "winner" cards from the
-- Iterations sidebar. Wired to the red ✕ button on each WinnerCard.
--
-- Soft-hide only (no row deletion in creative_analysis). The /iterations
-- query LEFT-JOINs / NOT EXISTS against this table so dismissed cards stop
-- appearing in the UI but remain in analytics.
--
-- Operator can un-dismiss via:
--   DELETE FROM dismissed_iteration_winners WHERE creative_id = '<IMxxxx>';
CREATE TABLE IF NOT EXISTS dismissed_iteration_winners (
  creative_id   TEXT PRIMARY KEY,
  dismissed_by  INTEGER,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dismissed_iter_winners_at
  ON dismissed_iteration_winners (dismissed_at DESC);
