-- Async /edit refactor: background job needs a way to surface errors back
-- to the frontend (since the HTTP response returns immediately after the
-- job is queued). The frontend polls GET /creatives/:id and shows
-- last_edit_error if it's populated.
ALTER TABLE spy_creatives
  ADD COLUMN IF NOT EXISTS last_edit_error TEXT;
