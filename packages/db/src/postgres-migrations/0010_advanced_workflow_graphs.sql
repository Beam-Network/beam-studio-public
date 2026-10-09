ALTER TABLE IF EXISTS workflow.templates
  ADD COLUMN IF NOT EXISTS graph_version text NOT NULL DEFAULT 'workflow-graph/v1',
  ADD COLUMN IF NOT EXISTS graph_json jsonb NOT NULL DEFAULT '{"version":"workflow-graph/v1","controls":[],"edges":[]}'::jsonb;

CREATE TABLE IF NOT EXISTS execution.workflow_dynamic_regions (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  control_id text NOT NULL,
  control_path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('loop', 'fan-out')),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'expanding', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'skipped', 'not_reached')
  ),
  definition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_input_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  instance_count integer NOT NULL DEFAULT 0,
  completed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  cancelled_count integer NOT NULL DEFAULT 0,
  concurrency_limit integer,
  error text,
  cancellation_requested_at timestamptz,
  retry_requested_at timestamptz,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_dynamic_regions_count_check CHECK (
    instance_count >= 0 AND completed_count >= 0 AND failed_count >= 0 AND cancelled_count >= 0
  ),
  CONSTRAINT execution_workflow_dynamic_regions_unique_path UNIQUE (workflow_run_id, control_path)
);

CREATE TABLE IF NOT EXISTS execution.workflow_dynamic_instances (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  dynamic_region_id text NOT NULL REFERENCES execution.workflow_dynamic_regions(id) ON DELETE CASCADE,
  workflow_step_id text NOT NULL REFERENCES workflow.steps(id) ON DELETE RESTRICT,
  control_path text NOT NULL,
  instance_index integer NOT NULL CHECK (instance_index >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'not_reached')
  ),
  current_attempt integer NOT NULL DEFAULT 1 CHECK (current_attempt >= 1),
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_dynamic_instances_unique_logical
    UNIQUE (workflow_run_id, control_path, workflow_step_id, instance_index)
);

ALTER TABLE IF EXISTS execution.workflow_step_runs
  ADD COLUMN IF NOT EXISTS dynamic_instance_id text
    REFERENCES execution.workflow_dynamic_instances(id) ON DELETE CASCADE;
ALTER TABLE IF EXISTS execution.workflow_step_runs
  DROP CONSTRAINT IF EXISTS workflow_step_runs_unique_step;
ALTER TABLE IF EXISTS execution.workflow_step_runs
  DROP CONSTRAINT IF EXISTS execution_workflow_step_runs_unique_step;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_workflow_step_runs_static_unique
  ON execution.workflow_step_runs(workflow_run_id, workflow_step_id)
  WHERE dynamic_instance_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_workflow_step_runs_dynamic_unique
  ON execution.workflow_step_runs(dynamic_instance_id)
  WHERE dynamic_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution.workflow_condition_evaluations (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  dynamic_region_id text REFERENCES execution.workflow_dynamic_regions(id) ON DELETE CASCADE,
  dynamic_instance_id text REFERENCES execution.workflow_dynamic_instances(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  edge_id text NOT NULL,
  from_node_id text NOT NULL,
  to_node_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('taken', 'skipped', 'not_reached')),
  result boolean,
  reason text NOT NULL,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_condition_evaluations_unique
    UNIQUE (workflow_run_id, scope_key, edge_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_workflow_dynamic_regions_run
  ON execution.workflow_dynamic_regions(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_dynamic_instances_region
  ON execution.workflow_dynamic_instances(dynamic_region_id, instance_index, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_dynamic_instances_run
  ON execution.workflow_dynamic_instances(workflow_run_id, control_path, status);
CREATE INDEX IF NOT EXISTS idx_execution_workflow_condition_evaluations_run
  ON execution.workflow_condition_evaluations(workflow_run_id, scope_key, created_at);
