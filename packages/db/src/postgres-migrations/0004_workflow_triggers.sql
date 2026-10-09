CREATE TABLE IF NOT EXISTS workflow_triggers (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  canvas_x real,
  canvas_y real,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_trigger_edges (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  trigger_id text NOT NULL REFERENCES workflow_triggers(id) ON DELETE CASCADE,
  to_step_id text NOT NULL,
  condition_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS trigger_id text,
  ADD COLUMN IF NOT EXISTS trigger_type text,
  ADD COLUMN IF NOT EXISTS trigger_event_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_pg_workflow_triggers_template
  ON workflow_triggers(workflow_template_id, type);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_triggers_schedule
  ON workflow_triggers(type, enabled);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_trigger_edges_template
  ON workflow_trigger_edges(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_trigger_edges_trigger
  ON workflow_trigger_edges(trigger_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_trigger_edges_to
  ON workflow_trigger_edges(to_step_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_runs_trigger
  ON workflow_runs(trigger_id, created_at);
