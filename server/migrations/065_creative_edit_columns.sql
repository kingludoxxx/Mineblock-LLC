-- Operator-driven inline image editing via OpenAI gpt-image-2.
-- Edit is allowed ONLY when status='review' (locked once card moves to
-- ready/approved/launched). Architecture: preview-before-commit —
-- Generate stores pending_edit_url, Accept promotes it + cascades 4:5/9:16
-- regeneration, Discard clears it.
ALTER TABLE spy_creatives
  ADD COLUMN IF NOT EXISTS pending_edit_url   TEXT,
  ADD COLUMN IF NOT EXISTS pending_edit_token TEXT,
  ADD COLUMN IF NOT EXISTS previous_image_url TEXT,
  ADD COLUMN IF NOT EXISTS last_edit_prompt   TEXT,
  ADD COLUMN IF NOT EXISTS last_edited_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_spy_creatives_pending_edit
  ON spy_creatives (last_edited_at DESC)
  WHERE pending_edit_url IS NOT NULL;
