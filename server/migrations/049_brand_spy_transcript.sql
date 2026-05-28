-- Per-ad video transcript cache.
-- When a user clicks "Transcribe" in the IntelDrawer, we download the
-- video, hand it to OpenAI Whisper, and persist the result here so the
-- next click is instant (and free).

ALTER TABLE brand_spy.ads
  ADD COLUMN IF NOT EXISTS transcript     TEXT,
  ADD COLUMN IF NOT EXISTS transcript_at  TIMESTAMPTZ;

COMMENT ON COLUMN brand_spy.ads.transcript IS
  'Whisper-generated transcript of the ad''s video, NULL until the user requests transcription via the IntelDrawer. Plain text, no timestamps.';

COMMENT ON COLUMN brand_spy.ads.transcript_at IS
  'UTC timestamp when the transcript was generated. Used to invalidate the cache if we ever re-detect a different video_url on the same ad.';
