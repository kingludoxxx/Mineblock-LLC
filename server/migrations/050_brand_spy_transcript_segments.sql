-- Per-segment timestamps for the Whisper transcript so the Video Script
-- panel can render line-by-line with "00:00", "00:05", "00:11" markers
-- (matches the Atria reference).
--
-- Stored as JSONB array of { start: float, end: float, text: string }.

ALTER TABLE brand_spy.ads
  ADD COLUMN IF NOT EXISTS transcript_segments JSONB;

COMMENT ON COLUMN brand_spy.ads.transcript_segments IS
  'Whisper verbose_json segments — JSONB array of { start, end, text } where start/end are seconds (float). NULL when only the plain-text transcript is available (older rows transcribed before verbose_json was wired up).';
