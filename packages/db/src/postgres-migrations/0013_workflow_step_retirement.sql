ALTER TABLE IF EXISTS workflow.steps
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;
