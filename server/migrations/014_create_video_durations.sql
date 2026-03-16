-- Video durations cache: stores Frame.io video duration data per brief
-- Populated via browser-side sync from Frame.io, served by the API

CREATE TABLE IF NOT EXISTS video_durations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  frame_asset_id VARCHAR(100) NOT NULL,
  brief_code VARCHAR(20),
  task_name TEXT,
  editor VARCHAR(100),
  week_code VARCHAR(20),
  duration_seconds NUMERIC(10, 3) DEFAULT 0,
  video_count INTEGER DEFAULT 1,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(frame_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_video_durations_editor ON video_durations(editor);
CREATE INDEX IF NOT EXISTS idx_video_durations_week ON video_durations(week_code);
CREATE INDEX IF NOT EXISTS idx_video_durations_brief ON video_durations(brief_code);
