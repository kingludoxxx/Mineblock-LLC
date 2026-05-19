-- Migration 035: Statics generation monitoring events table
-- P6: Log every generation attempt for operational health tracking

CREATE TABLE IF NOT EXISTS statics_generation_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID,
  product_id      INTEGER,
  product_name    TEXT,
  angle           TEXT,
  provider        TEXT,               -- 'gemini' | 'playwright' | 'nanobanana'
  ratios          TEXT[],             -- ['1:1','4:5','9:16']
  duration_ms     INTEGER,            -- total wall-clock ms from Claude start to all ratios done
  claude_ms       INTEGER,            -- ms for Claude analysis step only
  status          TEXT NOT NULL,      -- 'success' | 'error' | 'partial'
  error_message   TEXT,
  quality_warning TEXT,               -- non-null if vision audit flagged an issue
  retry_count     INTEGER DEFAULT 0,  -- how many Gemini/NB retries were needed
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gen_events_created   ON statics_generation_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_events_status     ON statics_generation_events (status);
CREATE INDEX IF NOT EXISTS idx_gen_events_provider   ON statics_generation_events (provider);
CREATE INDEX IF NOT EXISTS idx_gen_events_template   ON statics_generation_events (template_id)
  WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gen_events_product    ON statics_generation_events (product_id)
  WHERE product_id IS NOT NULL;
