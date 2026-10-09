-- A step's label is node metadata, not action configuration, so it becomes a
-- real column alongside the name columns triggers and decisions already have.
-- It previously lived in config_json.name by convention; backfill those.
ALTER TABLE IF EXISTS workflow.steps
  ADD COLUMN IF NOT EXISTS name text;

UPDATE workflow.steps
SET name = config_json->>'name'
WHERE name IS NULL
  AND config_json ? 'name'
  AND length(trim(config_json->>'name')) > 0;
