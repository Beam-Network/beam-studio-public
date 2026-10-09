CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_packages (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  name text NOT NULL,
  version text NOT NULL,
  source text NOT NULL,
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_packages_name_version_source_unique UNIQUE (name, version, source)
);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  legacy_transfer_template_id text,
  name text NOT NULL,
  description text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeout_seconds integer,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id),
  action_package_name text NOT NULL,
  action_version_range text NOT NULL DEFAULT '*',
  position integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_bindings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  placement text NOT NULL DEFAULT 'local-workers',
  execution_location_id text,
  canvas_x real,
  canvas_y real,
  timeout_seconds integer,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_steps_position_check CHECK (position >= 0),
  CONSTRAINT workflow_steps_template_position_unique UNIQUE (workflow_template_id, position)
);

CREATE TABLE IF NOT EXISTS workflow_edges (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id),
  from_step_id text NOT NULL,
  to_step_id text NOT NULL,
  condition_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_plan_versions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  compiled_plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT workflow_plan_versions_template_version_unique UNIQUE (workflow_template_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id),
  workflow_plan_version_id text REFERENCES workflow_plan_versions(id),
  legacy_run_id text,
  status text NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_status_check CHECK (
    status IN ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')
  )
);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  workflow_step_id text NOT NULL,
  action_package_name text NOT NULL,
  resolved_version text NOT NULL,
  checksum text NOT NULL,
  source_registry text NOT NULL,
  resolved_placement text NOT NULL,
  execution_location_id text,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_ref text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_step_runs_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'not_reached')
  ),
  CONSTRAINT workflow_step_runs_unique_step UNIQUE (workflow_run_id, workflow_step_id)
);

CREATE TABLE IF NOT EXISTS execution_plans (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  workflow_plan_version_id text REFERENCES workflow_plan_versions(id),
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  status text NOT NULL DEFAULT 'active',
  plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduler_explanation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_plan_nodes (
  id text PRIMARY KEY,
  execution_plan_id text NOT NULL REFERENCES execution_plans(id),
  workflow_step_id text NOT NULL,
  action_package_name text NOT NULL,
  resolved_version text NOT NULL,
  node_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_plan_nodes_step_unique UNIQUE (execution_plan_id, workflow_step_id)
);

CREATE TABLE IF NOT EXISTS execution_plan_edges (
  id text PRIMARY KEY,
  execution_plan_id text NOT NULL REFERENCES execution_plans(id),
  from_node_id text NOT NULL,
  to_node_id text NOT NULL,
  condition_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_plan_shards (
  id text PRIMARY KEY,
  execution_plan_id text NOT NULL REFERENCES execution_plans(id),
  workflow_task_id text,
  shard_index integer,
  shard_kind text NOT NULL,
  assigned_worker_id text,
  nats_subject text,
  status text NOT NULL,
  input_weight integer NOT NULL DEFAULT 0,
  source_locality text,
  destination_locality text,
  output_checksum text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_runtime_state (
  worker_id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  network_identity text NOT NULL,
  status text NOT NULL,
  reachability text NOT NULL DEFAULT 'local',
  accessible_endpoints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  version text,
  cpu_load real NOT NULL DEFAULT 0,
  memory_used_bytes bigint NOT NULL DEFAULT 0,
  memory_total_bytes bigint NOT NULL DEFAULT 0,
  bandwidth_mbps real NOT NULL DEFAULT 0,
  active_task_count integer NOT NULL DEFAULT 0,
  load_score real NOT NULL DEFAULT 0,
  heartbeat_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_capabilities (
  id text PRIMARY KEY,
  worker_id text NOT NULL REFERENCES worker_runtime_state(worker_id),
  capability text NOT NULL,
  version_range text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_capabilities_worker_capability_unique UNIQUE (worker_id, capability)
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  workflow_step_run_id text REFERENCES workflow_step_runs(id),
  workflow_step_id text NOT NULL,
  task_kind text NOT NULL,
  action_package_name text NOT NULL,
  status text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  target_worker_id text,
  leased_by text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  shard_index integer,
  shard_count integer,
  input_checksum text NOT NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  placement_explanation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  nats_subject text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_tasks_status_check CHECK (
    status IN ('queued', 'leased', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled', 'dead_letter')
  )
);

CREATE TABLE IF NOT EXISTS workflow_task_attempts (
  id text PRIMARY KEY,
  workflow_task_id text NOT NULL REFERENCES workflow_tasks(id),
  attempt_number integer NOT NULL,
  worker_id text,
  status text NOT NULL,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_task_attempts_task_number_unique UNIQUE (workflow_task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  workflow_template_id text,
  workflow_run_id text,
  workflow_step_run_id text,
  workflow_task_id text,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  correlation_id text
);

CREATE TABLE IF NOT EXISTS workflow_task_dead_letters (
  id text PRIMARY KEY,
  workflow_task_id text NOT NULL REFERENCES workflow_tasks(id),
  workflow_run_id text NOT NULL,
  workflow_step_run_id text,
  reason text NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_task_dead_letters_task_unique UNIQUE (workflow_task_id)
);

CREATE TABLE IF NOT EXISTS workflow_action_locks (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow_templates(id),
  action_package_name text NOT NULL,
  version_range text NOT NULL,
  resolved_version text NOT NULL,
  checksum text NOT NULL,
  source_registry text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_locations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  kind text NOT NULL,
  endpoint_url text,
  encrypted_headers text,
  enabled boolean NOT NULL DEFAULT true,
  allow_insecure_http boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pg_workflow_templates_org
  ON workflow_templates(organization_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_steps_template_position
  ON workflow_steps(workflow_template_id, position);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_steps_action
  ON workflow_steps(action_package_name);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_edges_template
  ON workflow_edges(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_edges_from
  ON workflow_edges(from_step_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_edges_to
  ON workflow_edges(to_step_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_runs_status_queued
  ON workflow_runs(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_runs_template_created
  ON workflow_runs(workflow_template_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_step_runs_run_status
  ON workflow_step_runs(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_step_runs_step
  ON workflow_step_runs(workflow_step_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_tasks_claim
  ON workflow_tasks(status, scheduled_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_tasks_target_status
  ON workflow_tasks(target_worker_id, status);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_tasks_lease_expires
  ON workflow_tasks(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_tasks_step_kind
  ON workflow_tasks(workflow_step_run_id, task_kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_workflow_tasks_idempotency
  ON workflow_tasks(workflow_step_run_id, task_kind, COALESCE(shard_index, -1), input_checksum);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_events_run_created
  ON workflow_events(workflow_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pg_worker_runtime_state_status_heartbeat
  ON worker_runtime_state(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_pg_execution_plans_run
  ON execution_plans(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_pg_execution_plan_nodes_plan
  ON execution_plan_nodes(execution_plan_id);
CREATE INDEX IF NOT EXISTS idx_pg_execution_plan_edges_plan
  ON execution_plan_edges(execution_plan_id);
CREATE INDEX IF NOT EXISTS idx_pg_execution_plan_shards_plan_status
  ON execution_plan_shards(execution_plan_id, status);
CREATE INDEX IF NOT EXISTS idx_pg_execution_plan_shards_task
  ON execution_plan_shards(workflow_task_id);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_task_dead_letters_created
  ON workflow_task_dead_letters(created_at);
CREATE INDEX IF NOT EXISTS idx_pg_workflow_action_locks_template
  ON workflow_action_locks(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_pg_execution_locations_org
  ON execution_locations(organization_id, enabled);
